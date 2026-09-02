/** 앱 셸 - 메뉴 렌더링, 해시 라우팅, 공통 헤더 처리 */
import { MENUS, ROLE, appOnlyCompany } from './config.js';
import { requireLogin, signOut, roleLabel } from './auth.js';
import { icon } from './icons.js';
import { esc, isMobile, MOBILE_QUERY } from './util.js';

/** 새 버전을 받으려고 새로고침했는지 (무한 새로고침 방지) */
const RELOAD_FLAG = 'tpl_chunk_reload';

const user = await requireLogin();
if (!user) throw new Error('로그인이 필요합니다.');

/** 라우트 정의 - 화면 모듈은 필요할 때 동적 import 한다 */
const ROUTES = {
    orders: () => import('./pages/orders.js'),
    status: () => import('./pages/status.js'),
    shipping: () => import('./pages/shipping.js'),
    loading: () => import('./pages/loading.js'),
    inspect: () => import('./pages/inspect.js'),
    issues: () => import('./pages/issues.js'),
    users: () => import('./pages/users.js'),
};

const view = document.getElementById('view');
const sideNav = document.getElementById('side-nav');
const tabbar = document.getElementById('tabbar');
const sidebar = document.getElementById('sidebar');

/** 모바일(앱)에서 처음 열 화면 - 주문정보등록은 앱 메뉴가 아니다 */
function homeKey() {
    return isMobile() || appOnly ? 'status' : 'orders';
}

/** 협력사 소속은 기기와 무관하게 앱 메뉴(mobile: true)만 쓴다 */
const appOnly = appOnlyCompany(user.company);

/** 현재 사용자에게 보여줄 메뉴 목록 */
const menus = MENUS
    .filter((m) => !m.adminOnly || user.role === ROLE.ADMIN)
    .filter((m) => !appOnly || m.mobile);

function renderNav() {
    sideNav.innerHTML = menus.map((m) => `
<a class="navlink" data-key="${m.key}" href="${m.path}">
  ${icon(m.icon, 'icon navlink__icon')}<span>${esc(m.label)}</span>
</a>`).join('');

    // 모바일 하단 탭바에는 현장에서 자주 쓰는 메뉴만 노출한다.
    // 나머지 메뉴는 상단 햄버거 버튼의 서랍에서 접근한다.
    tabbar.innerHTML = menus.filter((m) => m.mobile).map((m) => `
<a class="tab" data-key="${m.key}" href="${m.path}">
  ${icon(m.icon, 'icon tab__icon')}<span class="tab__label">${esc(m.label)}</span>
</a>`).join('');

    // 소속 → 권한 → 이름 순서로 보여준다
    const meHtml = `<span class="me__company">${esc(user.company)}</span>
        <span class="role role--${user.role}">${esc(roleLabel(user.role))}</span>
        <strong>${esc(user.name)}</strong>`;
    document.getElementById('side-me').innerHTML = meHtml;
    document.getElementById('top-me').innerHTML = meHtml;
    document.getElementById('btn-menu').innerHTML = icon('menu', 'icon');
    document.getElementById('btn-top-logout').innerHTML = icon('logout', 'icon');
}

function markActive(key) {
    document.querySelectorAll('[data-key]').forEach((el) => {
        el.classList.toggle('is-active', el.dataset.key === key);
    });
    const menu = MENUS.find((m) => m.key === key);
    document.getElementById('page-title').textContent = menu?.label ?? '검수';
}

/** 현재 화면의 정리(cleanup) 함수 - 구독 해제 등에 사용 */
let cleanup = null;

async function render() {
    const hash = location.hash.replace(/^#\//, '') || homeKey();
    const [key, ...rest] = hash.split('/');

    if (!ROUTES[key]) {
        location.hash = `#/${homeKey()}`;
        return;
    }
    // 모바일과 협력사는 하단 탭에 있는 메뉴만 쓴다 (주문정보등록·사용자관리는 웹 전용)
    const target = MENUS.find((m) => m.key === key);
    if ((isMobile() || appOnly) && target && !target.mobile) {
        location.hash = `#/${homeKey()}`;
        return;
    }
    if (MENUS.find((m) => m.key === key)?.adminOnly && user.role !== ROLE.ADMIN) {
        view.innerHTML = '<div class="empty">접근 권한이 없습니다.</div>';
        return;
    }

    if (typeof cleanup === 'function') cleanup();
    cleanup = null;
    view.innerHTML = '<div class="empty">불러오는 중...</div>';
    sidebar.classList.remove('is-open');

    markActive(key === 'inspect' ? 'loading' : key);

    // 🔑 새 버전을 배포하면 화면 파일 이름이 바뀌고 옛 파일은 사라진다.
    // 그때 브라우저가 이전 버전을 들고 있으면 없는 파일을 불러 화면이 멈춘다.
    // 한 번만 새로고침해 새 버전을 받는다 (계속 실패하면 안내로 끝낸다).
    let mod;
    try {
        mod = await ROUTES[key]();
    } catch (err) {
        console.warn('화면을 불러오지 못했습니다. 새 버전을 받습니다.', err);
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
            sessionStorage.setItem(RELOAD_FLAG, '1');
            location.reload();
            return;
        }
        view.innerHTML = `
<div class="empty">
  화면을 불러오지 못했습니다.<br>
  새로고침해도 같으면 앱을 완전히 닫았다가 다시 열어 주세요.
</div>`;
        return;
    }
    sessionStorage.removeItem(RELOAD_FLAG);   // 정상적으로 열렸으면 플래그를 지운다

    cleanup = await mod.render(view, { user, params: rest });
    view.scrollTop = 0;
}

/** 로그아웃 - 사이드바(PC)와 상단바(모바일) 두 버튼이 공유한다 */
async function logout() {
    await signOut();
    location.replace('index.html');
}

document.getElementById('btn-logout').addEventListener('click', logout);
document.getElementById('btn-top-logout').addEventListener('click', logout);

document.getElementById('btn-menu').addEventListener('click', () => {
    sidebar.classList.toggle('is-open');
});

// 창 크기가 기준점을 넘나들 때 앱 메뉴 밖 화면에 있으면 되돌린다
window.matchMedia(MOBILE_QUERY).addEventListener('change', render);

window.addEventListener('hashchange', render);

renderNav();
render();
