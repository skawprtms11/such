/**
 * 로그인 세션 및 권한 판정.
 *
 *   mock     : 계정 목록에서 고르는 임시 로그인 (비밀번호 검증 없음)
 *   supabase : Supabase Auth 의 이메일 + 비밀번호 로그인
 *
 * 로그인한 사용자의 프로필(`profiles` 행)을 세션 저장소에 담아두고,
 * 화면은 `currentUser()` 로만 읽는다.
 */
import { PERMISSION, ROLE_LABEL } from './config.js';
import { listUsers } from './db.js';
import { isSupabase } from './store.js';
import { supabase } from './supabase.js';

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

function keepUser(user, keepLogin) {
    const store = keepLogin ? localStorage : sessionStorage;
    store.setItem(SESSION_KEY, JSON.stringify(user));
}

function clearUser() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
}

/**
 * 로그인 처리.
 * @param {{userId?:string, email?:string, password?:string, keepLogin?:boolean}} opt
 *   mock 은 `userId`, supabase 는 `email` + `password` 를 쓴다.
 */
export async function signIn({ userId, email, password, keepLogin = false }) {
    if (!isSupabase) {
        const users = await listUsers();
        const user = users.find((u) => u.id === userId);
        if (!user) throw new Error('사용자를 찾을 수 없습니다.');
        if (!user.active) throw new Error('사용이 중지된 계정입니다. 관리자에게 문의하세요.');
        keepUser(user, keepLogin);
        return user;
    }

    const sb = supabase();
    const { data, error } = await sb.auth.signInWithPassword({
        email: String(email ?? '').trim(),
        password: password ?? '',
    });
    if (error) {
        throw new Error(error.message === 'Invalid login credentials'
            ? '이메일 또는 비밀번호가 맞지 않습니다.'
            : `로그인에 실패했습니다: ${error.message}`);
    }

    const { data: profile, error: perr } = await sb
        .from('profiles').select('*').eq('id', data.user.id).single();
    if (perr || !profile) {
        await sb.auth.signOut();
        throw new Error('사용자 프로필이 없습니다. 관리자에게 문의하세요.');
    }
    if (!profile.active) {
        await sb.auth.signOut();
        throw new Error('사용이 중지된 계정입니다. 관리자에게 문의하세요.');
    }

    keepUser(profile, keepLogin);
    return profile;
}

export async function signOut() {
    clearUser();
    if (isSupabase) {
        try {
            await supabase().auth.signOut();
        } catch (err) {
            console.warn('Supabase 로그아웃 실패', err);
        }
    }
}

/**
 * 로그인 상태가 아니면 로그인 화면으로 보낸다.
 * Supabase 모드에서는 **서버 세션이 살아 있는지도 확인한다.**
 * (토큰이 만료되면 프로필만 남아 있어도 데이터를 읽을 수 없다)
 */
export async function requireLogin() {
    const user = currentUser();
    if (!user) {
        location.replace('index.html');
        return null;
    }
    if (isSupabase) {
        const { data } = await supabase().auth.getSession();
        if (!data.session) {
            clearUser();
            location.replace('index.html');
            return null;
        }
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
