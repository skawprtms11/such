/**
 * 모바일 앱 셸 (m.html) - 해시 라우터 · 하단 탭 · 상단바 메뉴.
 *
 * 웹 셸(assets/js/app.js)과 화면 층을 공유하지 않는다.
 * 여기서 부르는 화면은 assets/js/mobile/screens/** 뿐이며,
 * 업무 규칙은 그대로 db.js · steps.js 에 둔다.
 */
import { APP_TABS, APP_MENU } from '../config.js';
import { requireLogin, signOut, roleLabel } from '../auth.js';
import { icon } from '../icons.js';
import { esc } from '../util.js';

/** 새 버전을 받으려고 새로고침했는지 (무한 새로고침 방지) - 웹 셸과 같은 키를 쓴다 */
const RELOAD_FLAG = 'tpl_chunk_reload';

/** 홈은 첫 번째 탭(출고작업)이다. 앱을 열면 바로 스캔할 수 있어야 한다 */
const HOME = APP_TABS[0].key;

/** 라우트 메타 - 하단 탭 5개 + 상단바 메뉴 항목 */
const ROUTES = [...APP_TABS, ...APP_MENU];

const user = await requireLogin();
if (!user) throw new Error('로그인이 필요합니다.');

/**
 * 화면 모듈 - 필요할 때 동적 import 한다.
 * 목록에 없는 라우트는 라우터가 "준비 중" 빈 화면을 그린다.
 * screens/<키>.js 를 만들 때마다 `<키>: () => import('./screens/<키>.js'),` 를 더한다.
 */
const SCREENS = {};

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

/** 진입 시점의 이력 길이 - 뒤로가기가 앱 밖으로 나가는 것을 막는 기준 */
const entryHistoryLen = history.length;

/**
 * 빈 화면. 다음 행동이 있으면 버튼을 함께 그린다.
 * 1단계에서 mobile/ui.js 로 옮겨 화면들이 함께 쓴다.
 * @param {string} msg 안내 문구
 * @param {{label:string, href:string}|null} action 다음 행동 버튼
 */
function emptyState(msg, action = null) {
    const btn = action
        ? `<a class="m-btn m-btn--primary" href="${esc(action.href)}">${esc(action.label)}</a>`
        : '';
    return `<div class="m-empty"><p class="m-empty__msg">${esc(msg)}</p>${btn}</div>`;
}

/** 하단 탭바 · 상단바 메뉴 · 사용자 정보를 한 번만 그린다 */
function renderShell() {
    tabbar.innerHTML = APP_TABS.map((t) => `
<a class="m-tab" data-key="${t.key}" href="${t.route}">
  ${icon(t.icon, 'm-icon m-tab__icon')}<span class="m-tab__label">${esc(t.label)}</span>
</a>`).join('');

    document.getElementById('m-drawer-nav').innerHTML = APP_MENU.map((m) => `
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
    const meta = ROUTES.find((r) => r.key === key);
    if (!meta) {
        location.replace(`#/${HOME}`);
        return;
    }

    // 화면을 떠나기 전에 반드시 이전 화면을 정리한다
    if (typeof cleanup === 'function') cleanup();
    cleanup = null;
    const seq = ++renderSeq;

    titleEl.textContent = meta.title;
    backBtn.hidden = params.length === 0;
    tabbar.querySelectorAll('[data-key]').forEach((el) => {
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

    const done = await mod.render(view, { user, params });
    // 불러오는 동안 다른 화면으로 옮겨 갔으면 방금 만든 화면을 바로 정리한다
    if (seq !== renderSeq) {
        if (typeof done === 'function') done();
        return;
    }
    cleanup = done;
    view.scrollTop = 0;
}

/** 상세에서 목록으로. 링크로 곧장 들어와 이력이 없으면 그 탭의 첫 화면으로 보낸다 */
backBtn.addEventListener('click', () => {
    if (history.length > entryHistoryLen) {
        history.back();
        return;
    }
    const [key] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    location.replace(`#/${key ?? HOME}`);
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
