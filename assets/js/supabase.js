/**
 * Supabase 클라이언트 (싱글턴).
 * 설정은 `.env.local` 의 VITE_SUPABASE_* 에서 온다. 소스에 키를 넣지 않는다.
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE } from './config.js';

let client = null;

/** 설정이 채워져 있는지 */
export function supabaseReady() {
    return Boolean(SUPABASE.url && SUPABASE.anonKey);
}

export function supabase() {
    if (!client) {
        if (!supabaseReady()) {
            throw new Error(
                'Supabase 설정이 없습니다. .env.local 의 VITE_SUPABASE_URL / '
                + 'VITE_SUPABASE_ANON_KEY 를 확인하세요.',
            );
        }
        client = createClient(SUPABASE.url, SUPABASE.anonKey, {
            auth: {
                persistSession: true,      // 새로고침해도 로그인 유지
                autoRefreshToken: true,
                storageKey: 'tpl_auth',
            },
        });
    }
    return client;
}
