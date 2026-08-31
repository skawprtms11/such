/** 앱 셸 - 메뉴 렌더링, 해시 라우팅, 공통 헤더 처리 */
import { MENUS, ROLE, appOnlyCompany } from './config.js';
import { requireLogin, signOut, roleLabel } from './auth.js';
import { icon } from './icons.js';
import { esc } from './util.js';

const user = requireLogin();
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

/** 모바일 여부 - CSS 의 반응형 기준점(860px)과 같은 값을 쓴다 */
const MOBILE_QUERY = '(max-width: 860px)';

function isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

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

    const meHtml = `<strong>${esc(user.name)}</strong>
        <span class="role role--${user.role}">${esc(roleLabel(user.role))}</span>`;
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
    const mod = await ROUTES[key]();
    cleanup = await mod.render(view, { user, params: rest });
    view.scrollTop = 0;
}

/** 로그아웃 - 사이드바(PC)와 상단바(모바일) 두 버튼이 공유한다 */
function logout() {
    signOut();
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
