/**
 * 웹 셸(app.html) · 앱 셸(m.html) 분기 - 유일한 출처.
 *
 * 로그인 화면(index.html) · 웹 셸(app.js) · 앱 셸(mobile/app.js) 세 곳이
 * 모두 이 모듈만 본다. 판정이 한 곳이라 두 셸이 서로 튕기는 무한 루프가 생기지 않는다.
 * (각 셸은 "내가 갈 곳이 상대 셸일 때만" 넘기므로 조건이 상호 배타다)
 */
import { appOnlyCompany } from './config.js';
import { isMobile } from './util.js';

export const WEB_SHELL = 'app.html';
export const APP_SHELL = 'm.html';

/** 셸 고정 키 - 태블릿 사용자의 탈출구. '?shell=web' / '?shell=app' 로 심는다 */
const FORCE_KEY = 'tpl_force_shell';

/** 셸을 고정한다 (앱의 `웹 화면으로` 버튼 등에서 사용) */
export function forceShell(kind) {
    localStorage.setItem(FORCE_KEY, kind);
}

/**
 * 주소의 `?shell=web|app` 을 고정 값으로 옮기고 쿼리에서 지운다.
 * 로그인 여부와 무관하므로 로그인 확인보다 **먼저** 부른다
 * (미로그인 상태로 들어와 로그인 화면으로 되돌아가도 고정 값이 남아야 한다).
 */
export function applyShellQuery() {
    const url = new URL(location.href);
    const want = url.searchParams.get('shell');
    if (want !== 'web' && want !== 'app') return;
    forceShell(want);
    url.searchParams.delete('shell');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

/**
 * 이 사용자·이 기기가 쓸 셸 주소.
 * 고정 값이 우선이고, 없으면 화면 폭(860px) 또는 협력사 소속으로 앱을 고른다.
 */
export function shellUrl(user) {
    const forced = localStorage.getItem(FORCE_KEY);
    if (forced === 'web') return WEB_SHELL;
    if (forced === 'app') return APP_SHELL;
    return (isMobile() || appOnlyCompany(user?.company)) ? APP_SHELL : WEB_SHELL;
}

/**
 * 웹 셸의 해시를 앱 셸의 해시로 옮긴다 (설계서 §1-5).
 * 앱에 없는 메뉴(주문정보등록·사용자관리)는 홈(빈 문자열)으로 보낸다.
 *
 * 🔑 웹의 `#/inspect/:id` 는 **상차검수**라 앱의 `#/load/:id` 로 간다.
 * 앱의 `#/inspect` 는 검수작업이어서 이름만 같고 화면이 다르다.
 */
export function appRoute(hash) {
    const [key, ...rest] = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
    if (key === 'shipping') return '#/ship';
    if (key === 'loading') return '#/load';
    if (key === 'inspect') return rest[0] ? `#/load/${rest[0]}` : '#/load';
    if (key === 'status' || key === 'issues') return `#/${key}`;
    return '';
}
