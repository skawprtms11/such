/**
 * 단색 라인 아이콘 모음.
 * 모든 아이콘은 stroke="currentColor" 를 쓰므로 놓인 자리의 글자색을 그대로 따른다.
 * (남색 사이드바에서는 흰색, 흰 배경 탭바에서는 회색/파랑으로 보인다)
 */

const PATHS = {
    // 주문정보등록 - 클립보드
    orders: `
        <path d="M9 4h6v2H9z" />
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
        <path d="M8.5 11.5h7M8.5 15.5h4.5" />`,

    // 주문처리현황 - 막대 그래프
    status: `
        <path d="M3.5 20.5h17" />
        <path d="M7 20.5v-5.5M12 20.5V6M17 20.5v-9" />`,

    // 출고주문처리 - 상자와 체크
    shipping: `
        <path d="M3.2 7.6 12 3l8.8 4.6v8.8L12 21l-8.8-4.6z" />
        <path d="M3.2 7.6 12 12.2l8.8-4.6M12 12.2V21" />
        <path d="M8.6 14.4l2 2 4-4" />`,

    // 당일상차리스트 - 트럭
    loading: `
        <path d="M2.5 7.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9h-11z" />
        <path d="M13.5 10.5h3.6a1 1 0 0 1 .8.4l2.6 3.3v2.3h-7z" />
        <circle cx="7" cy="18.5" r="2" />
        <circle cx="17" cy="18.5" r="2" />`,

    // 이슈등록 - 경고 삼각형
    issues: `
        <path d="M10.3 4.4 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z" />
        <path d="M12 9.5v4.5M12 17.3v.01" />`,

    // 사용자관리 - 사람 2명
    users: `
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20.5v-1.5a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v1.5" />
        <path d="M16 4.9a3.5 3.5 0 0 1 0 6.7" />
        <path d="M17.5 15.2a4 4 0 0 1 4 4v1.3" />`,

    // 로그아웃
    logout: `
        <path d="M9.5 20.5h-4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4" />
        <path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />`,

    // 햄버거 메뉴
    menu: '<path d="M4 7h16M4 12h16M4 17h16" />',

    // ── 버튼·목록용 (바코드 스캔 화면) ──

    // 카메라 스캔
    camera: `
        <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
        <circle cx="12" cy="13" r="3.2" />`,

    // 숫자 자판
    keypad: `
        <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
        <path d="M7 9.5h.01M12 9.5h.01M17 9.5h.01M7 14.5h.01M12 14.5h.01M17 14.5h.01" />`,

    // 스캔 중지
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" />',

    // 완료 (파렛트 검수·적치)
    check: `
        <circle cx="12" cy="12" r="8.5" />
        <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />`,

    // 미완료
    square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />',

    // 다음 차례
    next: '<path d="M9 6.5l7 5.5-7 5.5z" />',
};

/**
 * 아이콘 SVG 문자열을 만든다.
 * @param {string} name PATHS 의 키
 * @param {string} className 추가할 클래스명
 */
export function icon(name, className = 'icon') {
    const d = PATHS[name];
    if (!d) return '';
    return [
        `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`,
        ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        d,
        '</svg>',
    ].join('');
}
