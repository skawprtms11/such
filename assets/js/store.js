/**
 * 저장소 계층.
 *
 * `db.js` 는 업무 규칙만 담당하고, 실제로 어디에 저장하는지는 이 모듈이 정한다.
 *
 *   mock     : localStorage 에 전체를 JSON 으로 넣는다 (Supabase 구축 전 방식)
 *   supabase : 테이블을 통째로 읽어 같은 모양의 객체로 만들고,
 *              저장할 때는 **바뀐 행만** 골라 upsert / delete 한다
 *
 * 화면 코드는 이 모듈을 직접 부르지 않는다. 반드시 `db.js` 를 거친다.
 */
import { DATA_SOURCE } from './config.js';
import { supabase } from './supabase.js';
import { STORE, idbGet, idbPut } from './idb.js';

const KEY = 'tpl_order_db_v1';

/** 지금 Supabase 를 쓰는지 */
export const isSupabase = DATA_SOURCE === 'supabase';

/**
 * 테이블 정의.
 * `cols` 는 **화이트리스트**다. 여기 없는 필드는 서버로 보내지 않으므로,
 * 화면이 임시로 붙인 값(예: 파렛트의 label)이 섞여도 저장이 깨지지 않는다.
 *
 * 🔑 `scopedSelect` 는 **서버 select 정책이 「로그인 사용자 전부」보다 좁은** 테이블이다.
 * `pushChanges` 가 쓰기 결과를 되읽어 0행을 잡아내는데(RLS 무음 실패 탐지), 이 테이블들은
 * 쓰기가 성공해도 되읽기가 0행일 수 있어 **그 검사에서 뺀다.**
 * (예: orders 는 `can_view_all() or created_by = auth.uid()` 라 남의 주문은 되읽히지 않는다)
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
        scopedSelect: true,  // 본인 등록건만 보이거나(orders·issues) 주문 조회에 딸린다
        cols: [
            'id', 'reg_date', 'send_date', 'seq', 'order_no', 'base_no', 'rep_no', 'customer',
            'ship_req_date', 'vehicle_type', 'team_name', 'region',
            'extra_yn', 'packing_yn', 'work_note', 'packing_note', 'extra_works',
            'request_note', 'remark',
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
        scopedSelect: true,  // 본인 등록건만 보이거나(orders·issues) 주문 조회에 딸린다
        cols: ['id', 'order_id', 'barcode', 'scanned_at', 'location', 'picked_at'],
    },
    {
        key: 'history',
        name: 'order_history',
        scopedSelect: true,  // 본인 등록건만 보이거나(orders·issues) 주문 조회에 딸린다
        cols: [
            'id', 'order_id', 'rev', 'field', 'before', 'after', 'memo',
            'changed_by', 'changed_by_name', 'changed_at',
            'checked_at', 'checked_by', 'checked_by_name',
        ],
    },
    {
        key: 'restores',
        name: 'restore_requests',
        scopedSelect: true,  // 본인 등록건만 보이거나(orders·issues) 주문 조회에 딸린다
        cols: [
            'id', 'order_id', 'type', 'category', 'reason', 'product_code', 'qty',
            'created_by', 'created_by_name', 'created_at',
            'checked_at', 'checked_by', 'checked_by_name',
        ],
    },
    {
        key: 'issues',
        name: 'issues',
        scopedSelect: true,  // 본인 등록건만 보이거나(orders·issues) 주문 조회에 딸린다
        cols: [
            'id', 'type', 'work_type', 'title', 'order_no', 'content', 'due_date', 'status',
            'assignee_id', 'assignee_name', 'closed_at', 'canceled_at', 'auto_created',
            'created_by', 'created_at',
        ],
    },
    {
        key: 'comments',
        name: 'issue_comments',
        scopedSelect: true,  // 본인 등록건만 보이거나(orders·issues) 주문 조회에 딸린다
        cols: [
            'id', 'issue_id', 'parent_id', 'content',
            'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
        ],
    },
    {
        key: 'notices',
        name: 'notices',
        cols: [
            'id', 'title', 'content', 'important',
            'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
        ],
    },
    {
        key: 'noticeComments',
        name: 'notice_comments',
        cols: [
            'id', 'notice_id', 'parent_id', 'content',
            'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
        ],
    },
    {
        key: 'checklistItems',
        name: 'checklist_items',
        cols: [
            'id', 'category', 'parent_id', 'kind', 'child_flow', 'title', 'description',
            'cycle', 'weekday', 'monthday', 'assignee_id', 'assignee_name', 'sub_assignees',
            'sort_order', 'active', 'daily',
            'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
        ],
    },
    {
        key: 'checklistChecks',
        name: 'checklist_checks',
        cols: [
            'id', 'item_id', 'check_date', 'memo',
            'checked_by', 'checked_by_name', 'checked_at',
        ],
    },
    // ── 유통가공작업 (docs/processing.md) ──
    {
        key: 'processMasters',
        name: 'process_masters',
        cols: [
            'id', 'work_type', 'product_code', 'product_name',
            'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
        ],
    },
    {
        key: 'processMasterItems',
        name: 'process_master_items',
        cols: ['id', 'master_id', 'kind', 'code', 'name', 'qty_per', 'sort_order'],
    },
    {
        key: 'processJobs',
        name: 'process_jobs',
        cols: [
            'id', 'doc_no', 'master_id', 'work_type', 'product_code', 'product_name',
            'qty', 'start_date', 'due_date',
            'doc_created_at', 'doc_created_by', 'doc_created_by_name',
            // 모바일 검수 (docs/processing.md §17) - 상태를 움직이는 두 시각
            'pre_check_at', 'pre_check_by', 'pre_check_by_name',
            'done_at', 'done_by', 'done_by_name',
            'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
        ],
    },
    // ⚠️ 작업 1건이 구성품 행 수십 개를 만들어 가장 빨리 커지는 테이블이다.
    // 운영 6개월치를 넘기면 이 테이블만 기간 조건 조회로 빼는 것을 검토한다
    {
        key: 'processJobItems',
        name: 'process_job_items',
        cols: [
            'id', 'job_id', 'line_no', 'kind', 'code', 'name',
            'qty_per', 'lot', 'qty', 'sort_order',
        ],
    },
    // 검수 사진은 **메타만** 이 테이블에 둔다. 파일은 Storage 버킷(process-photos)이다
    {
        key: 'processPhotos',
        name: 'process_photos',
        cols: [
            'id', 'job_id', 'phase', 'line_no', 'seq', 'path', 'size',
            'taken_by', 'taken_by_name', 'taken_at',
        ],
    },
];

/** 검수 사진 Storage 버킷 (private · JPEG 만 · 1MB) */
const PHOTO_BUCKET = 'process-photos';

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

/**
 * mock 모드 저장소.
 * ⚠️ 샘플 데이터는 제거했다. 더미 계정·주문이 운영 배포본에 함께 실리기 때문이다.
 * 따라서 mock 모드는 **빈 상태로 시작한다.** 실제 데이터 확인은 Supabase 모드로 한다.
 */
function mockLoad() {
    const raw = localStorage.getItem(KEY);
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (err) {
            console.warn('저장 데이터 파싱 실패, 초기화합니다.', err);
        }
    }
    const empty = {
        users: [], orders: [], issues: [], pallets: [], history: [], restores: [], comments: [],
        notices: [], noticeComments: [], checklistItems: [], checklistChecks: [],
        processMasters: [], processMasterItems: [], processJobs: [], processJobItems: [],
        processPhotos: [],
    };
    localStorage.setItem(KEY, JSON.stringify(empty));
    return empty;
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
 *
 * 🔑 **RLS 에 막힌 수정·삭제는 오류가 아니라 「0행」으로 돌아온다.** PostgREST 는 그것을
 * 성공으로 준다. 그대로 두면 화면은 「저장됐습니다」 를 띄우는데 서버 값은 그대로다
 * (현장작업자의 유통가공 검수가 실제로 이렇게 조용히 실패했다). 그래서 쓰기 결과를
 * `.select('id')` 로 되읽어 **반영된 행 수를 확인한다.**
 * `scopedSelect` 테이블은 쓰기가 성공해도 되읽기가 막힐 수 있어 이 검사에서 뺀다.
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
            const { data, error } = await sb.from(t.name)
                .update(toRow(r, t.cols)).eq('id', r.id).select('id');
            if (error) throw new Error(`${t.name} 저장 실패: ${error.message}`);
            if (!t.scopedSelect && !(data ?? []).length) {
                throw new Error(`${t.name} 수정이 반영되지 않았습니다 (권한 또는 삭제된 행)`);
            }
        }
        if (removed.length) {
            const { data, error } = await sb.from(t.name)
                .delete().in('id', removed).select('id');
            if (error) throw new Error(`${t.name} 삭제 실패: ${error.message}`);
            if (!t.scopedSelect && (data ?? []).length !== removed.length) {
                throw new Error(`${t.name} 삭제가 반영되지 않았습니다 `
                    + `(${removed.length}건 중 ${(data ?? []).length}건 · 권한 또는 이미 지워진 행)`);
            }
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

/* -------------------------------- 파일 저장 -------------------------------- */
/**
 * 사진 **바이너리**는 행 diff 엔진(pushChanges)을 타지 않는다.
 * 파일 전용 API 둘만 두고 `db.js` 가 부른다 - 화면은 여전히 `db.*` 만 본다.
 * **지우는 API 는 두지 않는다.** 검수 취소도 사진을 남기고(A22) 경로가 결정적이라 재촬영이
 * 덮어쓰므로 부를 곳이 없었다. 고아 파일 정리가 필요해지면 그때 서버 쪽 일괄 작업으로 만든다.
 *
 *   mock     : IndexedDB (localStorage 한도를 사진이 채우면 주문 저장까지 막힌다)
 *   supabase : Storage 버킷 `process-photos` (private · 서명 URL 로만 본다)
 */

/** 파일 저장 - 같은 경로면 덮어쓴다 (경로가 결정적이라 재촬영이 고아를 남기지 않는다) */
export async function putFile(path, blob) {
    if (!isSupabase) {
        await idbPut(STORE.FILES, path, blob);
        return;
    }
    const { error } = await supabase().storage.from(PHOTO_BUCKET)
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) throw new Error(`사진 업로드 실패: ${error.message}`);
}

/**
 * 경로 → 보여줄 수 있는 주소.
 * 🔑 **Map 과 `release()` 를 함께** 돌려준다. mock 의 objectURL 은 화면을 떠날 때 revoke
 * 하지 않으면 새므로, 두 모드의 뒷정리 모양을 같게 해 화면이 저장소를 알지 못하게 한다.
 * @returns {Promise<{urls:Map<string,string>, release:Function}>}
 */
export async function fileUrls(paths) {
    const list = [...new Set(paths ?? [])].filter(Boolean);
    const urls = new Map();
    if (!list.length) return { urls, release() {} };

    if (!isSupabase) {
        const made = [];
        for (const p of list) {
            // IndexedDB 는 건별 조회뿐이다
            const blob = await idbGet(STORE.FILES, p);
            if (!blob) continue;
            const url = URL.createObjectURL(blob);
            urls.set(p, url);
            made.push(url);
        }
        return {
            urls,
            release() {
                made.splice(0).forEach((u) => URL.revokeObjectURL(u));
            },
        };
    }

    const { data, error } = await supabase().storage.from(PHOTO_BUCKET)
        .createSignedUrls(list, 600);
    if (error) throw new Error(`사진 주소 발급 실패: ${error.message}`);
    (data ?? []).forEach((d) => {
        if (d.signedUrl) urls.set(d.path, d.signedUrl);
    });
    return { urls, release() {} };
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
