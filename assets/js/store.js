/**
 * 저장소 계층.
 *
 * `db.js` 는 업무 규칙만 담당하고, 실제로 어디에 저장하는지는 이 모듈이 정한다.
 *
 *   mock     : localStorage 에 전체를 JSON 으로 넣는다 (Supabase 구축 전 방식)
 *   supabase : 테이블 6개를 읽어 같은 모양의 객체로 만들고,
 *              저장할 때는 **바뀐 행만** 골라 upsert / delete 한다
 *
 * 화면 코드는 이 모듈을 직접 부르지 않는다. 반드시 `db.js` 를 거친다.
 */
import { DATA_SOURCE } from './config.js';
import { SEED_USERS, SEED_ORDERS, SEED_ISSUES, makePallets } from './mock-data.js';
import { supabase } from './supabase.js';

const KEY = 'tpl_order_db_v1';

/** 지금 Supabase 를 쓰는지 */
export const isSupabase = DATA_SOURCE === 'supabase';

/**
 * 테이블 정의.
 * `cols` 는 **화이트리스트**다. 여기 없는 필드는 서버로 보내지 않으므로,
 * 화면이 임시로 붙인 값(예: 파렛트의 label)이 섞여도 저장이 깨지지 않는다.
 */
const TABLES = [
    {
        key: 'users',
        name: 'profiles',
        cols: ['id', 'name', 'email', 'company', 'role', 'phone', 'active'],
    },
    {
        key: 'orders',
        name: 'orders',
        cols: [
            'id', 'reg_date', 'send_date', 'seq', 'order_no', 'base_no', 'customer',
            'ship_req_date', 'vehicle_type', 'extra_works', 'request_note', 'remark',
            'item_count', 'qty', 'pallet_count', 'box_count', 'edit_count',
            'confirmed_at', 'confirmed_by', 'confirmed_by_name',
            'ship_started_at', 'ship_done_at', 'req_work_at', 'packing_at',
            'inspect_done_at', 'stow_done_at', 'extra_done_at', 'loaded_at', 'closed_at',
            'canceled_at', 'canceled_by', 'canceled_by_name',
            'ship_worker', 'inspect_worker', 'extra_worker',
            'inspected', 'load_status', 'created_by', 'created_at',
        ],
    },
    {
        key: 'pallets',
        name: 'pallets',
        cols: ['id', 'order_id', 'barcode', 'scanned_at', 'location', 'picked_at'],
    },
    {
        key: 'history',
        name: 'order_history',
        cols: [
            'id', 'order_id', 'rev', 'field', 'before', 'after', 'memo',
            'changed_by', 'changed_by_name', 'changed_at',
            'checked_at', 'checked_by', 'checked_by_name',
        ],
    },
    {
        key: 'restores',
        name: 'restore_requests',
        cols: [
            'id', 'order_id', 'type', 'category', 'reason', 'product_code', 'qty',
            'created_by', 'created_by_name', 'created_at',
            'checked_at', 'checked_by', 'checked_by_name',
        ],
    },
    {
        key: 'issues',
        name: 'issues',
        cols: [
            'id', 'type', 'title', 'order_no', 'content', 'due_date', 'status',
            'created_by', 'created_at',
        ],
    },
];

/* ------------------------------- 값 다듬기 ------------------------------- */

/**
 * 서버로 보낼 행을 만든다.
 * 화면에서 비워둔 날짜·시각·참조 컬럼은 빈 문자열로 들어오는데,
 * 그대로 보내면 타입 오류가 나므로 null 로 바꾼다.
 */
function toRow(row, cols) {
    const out = {};
    cols.forEach((c) => {
        let v = row[c];
        if (v === undefined) return;
        if (v === '' && (c.endsWith('_at') || c.endsWith('_date') || c.endsWith('_by'))) {
            v = null;
        }
        out[c] = v;
    });
    return out;
}

/** 두 행이 같은 내용인지 (컬럼 순서를 고정해 비교한다) */
function same(a, b, cols) {
    return JSON.stringify(toRow(a, cols)) === JSON.stringify(toRow(b, cols));
}

/* --------------------------------- mock --------------------------------- */

function mockLoad() {
    const raw = localStorage.getItem(KEY);
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (err) {
            console.warn('저장 데이터 파싱 실패, 초기화합니다.', err);
        }
    }
    const seeded = {
        users: SEED_USERS,
        orders: SEED_ORDERS,
        issues: SEED_ISSUES,
        pallets: SEED_ORDERS.flatMap(makePallets),
        history: [],
        restores: [],
    };
    localStorage.setItem(KEY, JSON.stringify(seeded));
    return seeded;
}

/* ------------------------------- supabase ------------------------------- */

/** 직전에 읽어둔 상태. 저장할 때 무엇이 바뀌었는지 가려내는 기준이다. */
let snapshot = null;

/** 짧은 캐시 - 한 화면이 db 함수를 연달아 부를 때 매번 조회하지 않게 한다 */
let cache = null;
let cacheAt = 0;
const CACHE_MS = 700;

/** 캐시를 버린다 (저장 직후·실시간 변경 알림 때) */
export function invalidate() {
    cache = null;
    cacheAt = 0;
}

async function fetchAll() {
    const sb = supabase();
    const results = await Promise.all(
        TABLES.map((t) => sb.from(t.name).select('*')),
    );
    const db = {};
    results.forEach((res, i) => {
        if (res.error) throw new Error(`${TABLES[i].name} 조회 실패: ${res.error.message}`);
        db[TABLES[i].key] = res.data ?? [];
    });
    return db;
}

/**
 * 바뀐 행만 서버에 반영한다.
 * 통째로 덮어쓰지 않으므로 다른 사람이 같은 시간에 넣은 값을 지우지 않는다.
 *
 * 🔑 **신규 등록(insert)과 수정(update)을 반드시 나눈다.**
 * upsert 는 INSERT 로 취급되어 등록 권한(RLS insert 정책)을 요구하는데,
 * 남이 만든 주문의 단계를 처리하는 것은 수정이지 등록이 아니다.
 */
async function pushChanges(db) {
    const sb = supabase();
    if (!snapshot) return;

    for (const t of TABLES) {
        const next = db[t.key] ?? [];
        const prev = snapshot[t.key] ?? [];
        const prevById = new Map(prev.map((r) => [r.id, r]));
        const nextIds = new Set(next.map((r) => r.id));

        const inserts = next.filter((r) => !prevById.has(r.id));
        const updates = next.filter((r) => {
            const before = prevById.get(r.id);
            return before && !same(before, r, t.cols);
        });
        const removed = prev.filter((r) => !nextIds.has(r.id)).map((r) => r.id);

        if (inserts.length) {
            const { error } = await sb.from(t.name)
                .insert(inserts.map((r) => toRow(r, t.cols)));
            if (error) throw new Error(`${t.name} 등록 실패: ${error.message}`);
        }
        for (const r of updates) {
            const { error } = await sb.from(t.name)
                .update(toRow(r, t.cols)).eq('id', r.id);
            if (error) throw new Error(`${t.name} 저장 실패: ${error.message}`);
        }
        if (removed.length) {
            const { error } = await sb.from(t.name).delete().in('id', removed);
            if (error) throw new Error(`${t.name} 삭제 실패: ${error.message}`);
        }
    }
}

/** 저장 기준점을 지금 상태로 다시 잡는다 */
function keepSnapshot(db) {
    snapshot = {};
    TABLES.forEach((t) => {
        snapshot[t.key] = (db[t.key] ?? []).map((r) => ({ ...r }));
    });
}

/* -------------------------------- 공개 API -------------------------------- */

/**
 * 전체 데이터를 읽는다.
 * @param {(db:object) => object} [normalize] 읽은 뒤 누락 필드를 채우는 함수.
 *   보정한 결과를 기준점으로 삼아야 **보정만으로 저장이 일어나지 않는다.**
 */
export async function loadDb(normalize = (x) => x) {
    if (!isSupabase) return normalize(mockLoad());

    const fresh = Date.now() - cacheAt < CACHE_MS;
    if (cache && fresh) return cache;

    const db = normalize(await fetchAll());
    keepSnapshot(db);
    cache = db;
    cacheAt = Date.now();
    return db;
}

/** 변경사항을 저장한다 */
export async function saveDb(db) {
    if (!isSupabase) {
        localStorage.setItem(KEY, JSON.stringify(db));
        return;
    }
    await pushChanges(db);
    keepSnapshot(db);      // 저장한 값이 새 기준이 된다
    cache = db;
    cacheAt = Date.now();
}

/** 저장 데이터를 시드 상태로 되돌린다 (개발용) */
export async function resetDb() {
    if (isSupabase) {
        throw new Error('Supabase 모드에서는 초기화를 지원하지 않습니다. SQL 로 직접 정리하세요.');
    }
    localStorage.removeItem(KEY);
    mockLoad();
}

/**
 * 데이터 변경 구독.
 *   mock     : 다른 탭의 storage 이벤트 + 주기적 폴링
 *   supabase : Realtime 채널. 끊겼을 때를 대비해 느슨한 폴링도 함께 돌린다
 * @returns {Function} 구독 해제
 */
export function subscribeStore(callback, intervalMs = 5000) {
    if (!isSupabase) {
        const onStorage = (e) => { if (e.key === KEY) callback(); };
        window.addEventListener('storage', onStorage);
        const timer = setInterval(callback, intervalMs);
        return () => {
            window.removeEventListener('storage', onStorage);
            clearInterval(timer);
        };
    }

    const sb = supabase();
    const channel = sb.channel(`tpl_${Math.random().toString(36).slice(2, 8)}`);
    TABLES.forEach((t) => {
        channel.on('postgres_changes', { event: '*', schema: 'public', table: t.name }, () => {
            invalidate();
            callback();
        });
    });
    channel.subscribe();

    // 실시간 연결이 끊겨도 화면이 멈추지 않게 한다
    const timer = setInterval(() => {
        invalidate();
        callback();
    }, Math.max(intervalMs, 15000));

    return () => {
        clearInterval(timer);
        sb.removeChannel(channel);
    };
}
