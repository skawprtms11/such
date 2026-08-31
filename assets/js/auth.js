/** 로그인 세션 및 권한 판정 */
import { PERMISSION, ROLE_LABEL } from './config.js';
import { listUsers } from './db.js';

const SESSION_KEY = 'tpl_session_user';

/** 현재 로그인 사용자 반환 (없으면 null) */
export function currentUser() {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.warn('세션 파싱 실패', err);
        return null;
    }
}

/** 로그인 처리 - 현재는 계정 선택 방식(Supabase Auth 연동 시 교체) */
export async function signIn(userId, keepLogin = false) {
    const users = await listUsers();
    const user = users.find((u) => u.id === userId);
    if (!user) throw new Error('사용자를 찾을 수 없습니다.');
    if (!user.active) throw new Error('사용이 중지된 계정입니다. 관리자에게 문의하세요.');
    const store = keepLogin ? localStorage : sessionStorage;
    store.setItem(SESSION_KEY, JSON.stringify(user));
    return user;
}

export function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
}

/** 로그인 상태가 아니면 로그인 화면으로 보낸다 */
export function requireLogin() {
    const user = currentUser();
    if (!user) {
        location.replace('index.html');
        return null;
    }
    return user;
}

/** 권한 확인 - can(user, 'download') 형태로 사용 */
export function can(user, key) {
    if (!user) return false;
    return Boolean(PERMISSION[user.role]?.[key]);
}

export function roleLabel(role) {
    return ROLE_LABEL[role] ?? role;
}

/**
 * 화면별 권한 정책 판정 - 역할 또는 소속 중 하나만 맞으면 허용한다.
 * @param {object} user 로그인 사용자
 * @param {{roles:string[], companies:string[]}} policy config.js 의 정책 객체
 */
export function allow(user, policy) {
    if (!user || !policy) return false;
    return policy.roles.includes(user.role) || policy.companies.includes(user.company);
}
