/**
 * 모바일 앱 셸 (m.html) - 해시 라우터 · 하단 탭 · 상단바 메뉴.
 *
 * 웹 셸(assets/js/app.js)과 화면 층을 공유하지 않는다.
 * 여기서 부르는 화면은 assets/js/mobile/screens/** 뿐이며,
 * 업무 규칙은 그대로 db.js · steps.js 에 둔다.
 */
import { APP_TAB_SETS, APP_MENU, tabSetOf } from '../config.js';
import { requireLogin, signOut, roleLabel, can } from '../auth.js';
import { icon } from '../icons.js';
import { esc } from '../util.js';
import { shellUrl, applyShellQuery, WEB_SHELL } from '../shell.js';
import { emptyState } from './ui.js';

/** 새 버전을 받으려고 새로고침했는지 (무한 새로고침 방지) - 웹 셸과 같은 키를 쓴다 */
const RELOAD_FLAG = 'tpl_chunk_reload';

// ?shell=app 탈출구는 로그인 확인보다 먼저 반영한다
applyShellQuery();

// 미로그인이면 requireLogin() 이 로그인 화면으로 되돌린다.
// 로그인 화면은 이미 로그인된 사용자를 다시 shellUrl() 로 보내므로,
// 앱 첫 화면에서 하드웨어 뒤로가기를 눌러도 웹 셸로 새지 않는다.
const user = await requireLogin();
if (!user) throw new Error('로그인이 필요합니다.');

// 백스톱 - 이 사용자가 웹 셸로 고정되어 있으면(태블릿 탈출구) app.html 로 넘긴다.
// 웹 셸의 조건과 상호 배타여서(shellUrl() 이 둘 중 하나만 반환) 되튕김이 없다.
if (shellUrl(user) === WEB_SHELL) {
    location.replace(WEB_SHELL);
    throw new Error('웹 화면으로 이동합니다.');
}

/**
 * 진입(조회) 게이트 - 탭·서랍·라우팅이 같은 기준을 쓴다.
 * 🔑 셸은 **조회 권한만** 본다. 처리 권한(updateStatus)은 각 화면이 판단한다 -
 * 화주 역할도 적치·상차 진행을 앱에서 조회해야 하기 때문이다.
 * 역할명을 직접 비교하지 않고 config.js 의 `viewPerm` 과 can() 으로만 판정한다.
 */
const allowed = (m) => !m.viewPerm || can(user, m.viewPerm);

/** 이 사용자가 쓸 수 있는 탭 세트·메뉴 (세트는 라우트에 따라 갈아 끼운다) */
const TAB_SETS = Object.fromEntries(
    Object.entries(APP_TAB_SETS).map(([name, tabs]) => [name, tabs.filter(allowed)]),
);
const MENU = APP_MENU.filter(allowed);

/** 라우트 메타 - 허용된 기본 탭 + 상단바 메뉴 항목 (유통가공은 서랍에 있다) */
const ROUTES = [...TAB_SETS.main, ...MENU];

/**
 * 이 라우트가 켤 탭 세트와 하위 탭 - 라우터와 뒤로가기가 **같은 판정 하나**를 쓴다.
 *
 * `tab` 의 값은 둘뿐이다 - 세그 세트가 아니면 `null`, 세그 세트면 **언제나 탭 하나**다
 * (세그가 없거나(`#/pcheck`) 틀리면(`#/pcheck/xxx`) 첫 탭). 주소를 옮겨야 하는지는
 * 부른 쪽이 `tab.seg !== params[0]` 로 본다 - 「없는 값」을 세 번째 뜻으로 쓰지 않는다.
 */
function tabStateOf(key, params) {
    let set = tabSetOf(key);
    // 권한 필터로 세트가 통째로 비면 기본 세트로 돌아간다 (탭 없는 탭바를 그리지 않게)
    if (!TAB_SETS[set]?.length) set = 'main';
    const segs = TAB_SETS[set].filter((t) => t.seg);
    const tab = segs.length ? (segs.find((t) => t.seg === params[0]) ?? segs[0]) : null;
    return { set, tab };
}

/** 홈은 첫 번째 탭(출고작업)이다. 앱을 열면 바로 스캔할 수 있어야 한다 */
const HOME = ROUTES[0]?.key ?? null;

/**
 * 화면 모듈 - 필요할 때 동적 import 한다.
 * 목록에 없는 라우트는 라우터가 "준비 중" 빈 화면을 그린다.
 * screens/<키>.js 를 만들 때마다 `<키>: () => import('./screens/<키>.js'),` 를 더한다.
 */
const SCREENS = {
    ship: () => import('./screens/ship.js'),
    inspect: () => import('./screens/inspect.js'),
    stow: () => import('./screens/stow.js'),
    adjust: () => import('./screens/adjust.js'),
    load: () => import('./screens/load.js'),
    pcheck: () => import('./screens/pcheck.js'),
    status: () => import('./screens/status.js'),
    issues: () => import('./screens/issues.js'),
    notices: () => import('./screens/notices.js'),
    checklist: () => import('./screens/checklist.js'),
    process: () => import('./screens/process.js'),
    wait: () => import('./screens/wait.js'),
    stock: () => import('./screens/stock.js'),
    account: () => import('./screens/account.js'),
};

const view = document.getElementById('view');
const tabbar = document.getElementById('m-tabbar');
const titleEl = document.getElementById('m-title');
const backBtn = document.getElementById('m-back');
const menuBtn = document.getElementById('m-menu-btn');
const drawer = document.getElementById('m-drawer');
const logoutBtn = document.getElementById('m-logout');

/** 현재 화면의 정리(cleanup) 함수 - 카메라 정지·구독 해제에 쓴다 */
let cleanup = null;

/** 화면 전환이 겹쳤을 때 마지막 요청만 그리기 위한 순번 */
let renderSeq = 0;

/**
 * 이력 깊이 - 앱이 push 한 이력인지 판정한다 (history.length 는 앱 밖의 이력까지 센다).
 * 새 항목(state 가 비어 있음)에만 도장을 찍고, 뒤로/앞으로는 찍힌 값을 그대로 따른다.
 */
let depth = -1;

function stampHistory() {
    const m = history.state?.m;
    if (m == null) {
        depth += 1;
        history.replaceState({ ...history.state, m: depth }, '');
    } else {
        depth = m;
    }
}

/** 직전 라우트 해시 - 뒤로가기가 같은 탭의 목록으로 가는지 확인할 때 쓴다 */
let prevRoute = null;
let curRoute = null;

/** 지금 그려 둔 탭 세트 이름 - 바뀔 때만 다시 그린다 */
let tabSet = null;

/**
 * 하단 탭바를 그린다. 세트가 그대로면 손대지 않는다
 * (같은 세트 안에서 화면만 옮길 때 탭이 깜빡이지 않게).
 */
function renderTabbar(name) {
    if (tabSet === name) return;
    tabSet = name;
    tabbar.innerHTML = (TAB_SETS[name] ?? []).map((t) => `
<a class="m-tab" data-key="${t.key}"${t.seg ? ` data-seg="${t.seg}"` : ''} href="${t.route}">
  ${icon(t.icon, 'm-icon m-tab__icon')}<span class="m-tab__label">${esc(t.label)}</span>
</a>`).join('');
}

/** 상단바 메뉴 · 사용자 정보를 한 번만 그린다 */
function renderShell() {
    document.getElementById('m-drawer-nav').innerHTML = MENU.map((m) => `
<a class="m-drawer__item" data-key="${m.key}" href="${m.route}">
  ${icon(m.icon, 'm-icon')}<span>${esc(m.title)}</span>
</a>`).join('');

    // 소속 → 이름 → 권한 순서로 보여준다 (웹 셸과 같은 순서)
    document.getElementById('m-drawer-me').innerHTML = `
<span class="m-me__company">${esc(user.company)}</span>
<strong class="m-me__name">${esc(user.name)}</strong>
<span class="m-me__role">${esc(roleLabel(user.role))}</span>`;

    backBtn.innerHTML = icon('back', 'm-icon');
    menuBtn.innerHTML = icon('menu', 'm-icon');
    logoutBtn.innerHTML = `${icon('logout', 'm-icon')}<span>로그아웃</span>`;
}

function setDrawer(open) {
    drawer.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
}

/**
 * 해시를 읽어 화면을 그린다.
 * `#/ship/o_1001` → key='ship', params=['o_1001'] (params 는 배열로 넘긴다)
 */
async function route() {
    const [key, ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

    // 🔑 화면을 떠나기 전에 반드시 이전 화면을 정리한다.
    // 알 수 없는 라우트로 튕겨 나가는 경로에서도 먼저 돌아야 카메라·폴링이 남지 않는다.
    // 정리 중에 예외가 나도 다음 화면은 떠야 한다
    const prev = cleanup;
    cleanup = null;
    try {
        prev?.();
    } catch (err) {
        console.warn('이전 화면 정리 실패', err);
    }

    const meta = ROUTES.find((r) => r.key === key);
    if (!meta) {
        // 권한이 없거나 없는 주소다. 쓸 수 있는 화면이 하나도 없으면 안내만 남긴다
        if (HOME) location.replace(`#/${HOME}`);
        else view.innerHTML = emptyState('이 계정으로 앱에서 쓸 수 있는 화면이 없습니다.');
        return;
    }

    // 🔑 유통가공처럼 하위 탭을 가진 세트는 params[0] 이 세그다 (`#/pcheck/pre`).
    // 세그가 없거나 틀리면 첫 탭으로 옮긴다 - `#/pcheck` 로 들어와도 탭 하나가 반드시 켜진다
    const { set, tab } = tabStateOf(key, params);
    if (tab && tab.seg !== params[0]) {
        location.replace(tab.route);
        return;
    }

    stampHistory();
    prevRoute = curRoute;
    curRoute = location.hash;
    const seq = ++renderSeq;

    renderTabbar(set);
    titleEl.textContent = tab?.title ?? meta.title;
    // 세그 세트는 목록도 params 를 하나 쓴다 - 상세(그 아래 :id)일 때만 뒤로가기를 보인다
    backBtn.hidden = params.length <= (tab ? 1 : 0);
    tabbar.querySelectorAll('[data-key]').forEach((el) => {
        el.classList.toggle('is-active', tab
            ? el.dataset.seg === tab.seg
            : el.dataset.key === key);
    });
    drawer.querySelectorAll('[data-key]').forEach((el) => {
        el.classList.toggle('is-active', el.dataset.key === key);
    });
    setDrawer(false);
    view.innerHTML = emptyState('불러오는 중...');

    const load = SCREENS[key];
    if (!load) {
        view.innerHTML = emptyState(`${meta.title} 화면은 준비 중입니다.`);
        return;
    }

    // 🔑 새 버전을 배포하면 화면 파일 이름이 바뀌고 옛 파일은 사라진다.
    // 브라우저가 이전 버전을 들고 있으면 없는 파일을 불러 화면이 멈추므로 한 번만 새로고침한다.
    let mod;
    try {
        mod = await load();
    } catch (err) {
        console.warn('화면을 불러오지 못했습니다. 새 버전을 받습니다.', err);
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
            sessionStorage.setItem(RELOAD_FLAG, '1');
            location.reload();
            return;
        }
        view.innerHTML = emptyState('화면을 불러오지 못했습니다. 앱을 닫았다가 다시 열어 주세요.');
        return;
    }
    sessionStorage.removeItem(RELOAD_FLAG);
    if (seq !== renderSeq) return;

    // 화면 하나가 죽어도 셸까지 멈추지 않게 감싼다
    let done;
    try {
        done = await mod.render(view, { user, params });
    } catch (err) {
        console.warn('화면을 여는 중 오류', err);
        if (seq === renderSeq) view.innerHTML = emptyState('화면을 여는 중 문제가 생겼습니다.');
        return;
    }
    // 불러오는 동안 다른 화면으로 옮겨 갔으면 방금 만든 화면을 바로 정리한다
    if (seq !== renderSeq) {
        if (typeof done === 'function') done();
        return;
    }
    cleanup = done;
    view.scrollTop = 0;
}

/**
 * 상세에서 목록으로.
 * 이 버튼은 상세에서만 보인다. 이력을 거슬러 **다른 탭의 상세로 새지 않도록**
 * 뒤가 같은 탭의 목록일 때만 뒤로 가고, 아니면 그 탭의 목록으로 바꿔 넣는다.
 */
backBtn.addEventListener('click', () => {
    const [key, ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    // 세그 세트는 목록이 `#/<키>/<세그>` 다 - 완료 검수 상세에서 작업전 목록으로 새지 않게 한다
    const { tab } = tabStateOf(key, params);
    const list = tab ? tab.route : `#/${key ?? HOME}`;
    if (history.state?.m > 0 && prevRoute === list) history.back();
    else location.replace(list);
});

menuBtn.addEventListener('click', () => setDrawer(drawer.hidden));
document.getElementById('m-drawer-dim').addEventListener('click', () => setDrawer(false));

// 이미 열려 있는 화면을 다시 고르면 해시가 바뀌지 않아 메뉴가 닫히지 않는다
drawer.addEventListener('click', (e) => {
    if (e.target.closest('a')) setDrawer(false);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setDrawer(false);
});

logoutBtn.addEventListener('click', async () => {
    await signOut();
    location.replace('index.html');
});

window.addEventListener('hashchange', route);

renderShell();
route();
