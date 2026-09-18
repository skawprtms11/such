/**
 * 데이터 접근 계층.
 * 화면 코드는 이 모듈의 함수만 사용하고, 내부 저장소(mock/Supabase)는 알지 못한다.
 * Supabase 구축 후에는 supabase-adapter.js 를 채우고 config.DATA_SOURCE 만 바꾸면 된다.
 */
import {
    CHECK_CYCLE, CHECK_KIND, CHECK_KINDS, CHECK_KIND_CHILDREN,
    CHECK_TEMPLATES, COMPANY, EXTRA_TASK_TYPE, INITIAL_PASSWORD, ISSUE_STATE,
    LOAD_STATUS, PERMISSION, RESTORE_TYPE, ROLE, WORK_STEPS, YN, LOCATION_FORMAT, FLOOR_LOCATION,
    adjustCategory, formatLocation, isValidLocation, stowStatus,
} from './config.js';
import { flowNos } from './checkflow.js';
import { readyToLoad, loadDone, visibleSteps } from './steps.js';
import {
    loadDb, saveDb, resetDb as storeReset, subscribeStore, isSupabase, invalidate,
} from './store.js';
import { supabase } from './supabase.js';
import { uid, today, toDateStr, addDays } from './util.js';

/**
 * 기능이 추가되면서 생긴 새 필드를 기존 저장 데이터에 채워 넣는다.
 * (이전 버전에서 저장된 데이터를 그대로 열어도 오류가 나지 않게 한다)
 */
function normalize(db) {
    db.restores = db.restores ?? [];
    db.comments = db.comments ?? [];
    db.notices = db.notices ?? [];
    db.noticeComments = db.noticeComments ?? [];
    db.checklistItems = db.checklistItems ?? [];
    db.checklistChecks = db.checklistChecks ?? [];
    db.checklistEdges = db.checklistEdges ?? [];
    db.checklistNotes = db.checklistNotes ?? [];
    // 종류(kind)가 없는 옛 항목 - 하위가 있으면 프로세스, 없으면 체크항목으로 본다
    const hasKid = new Set(db.checklistItems.map((i) => i.parent_id).filter(Boolean));
    db.checklistItems.forEach((i) => {
        i.parent_id = i.parent_id ?? null;
        i.kind = i.kind ?? (hasKid.has(i.id) ? CHECK_KIND.PROCESS : CHECK_KIND.CHECK);
        // 하위 프로세스 연결 방식이 없던 옛 항목은 순차(seq) - 지금까지의 모양 그대로다
        i.category = i.category ?? '';
        i.daily = i.daily ?? true;       // 포함 여부 컬럼이 없던 옛 항목은 포함으로 본다
        i.description = i.description ?? '';
        i.assignee_id = i.assignee_id ?? null;
        i.assignee_name = i.assignee_name ?? '';
        i.sub_assignees = Array.isArray(i.sub_assignees) ? i.sub_assignees : [];   // 부담당자
        i.sort_order = i.sort_order ?? 0;
        i.active = i.active !== false;
        i.deleted_at = i.deleted_at ?? null;
    });
    // 소속 명칭 변경 (더퓨어랩 → 고객사, 용마물류 → 용마로지스)
    const RENAMED = { 더퓨어랩: COMPANY.CUSTOMER, 용마물류: COMPANY.LOGISTICS };
    db.users.forEach((u) => {
        u.company = RENAMED[u.company] ?? u.company;
    });
    db.orders.forEach((o) => {
        o.extra_works = o.extra_works ?? [];
        o.edit_count = o.edit_count ?? 0;
        o.ship_req_date = o.ship_req_date ?? '';   // 미정(null)은 빈 값으로 다뤄 표시·정렬을 지킨다
        o.team_name = o.team_name ?? '';
        o.region = o.region ?? '국내';
        // 있음/없음 도입 전 데이터는 추가작업 배열 유무로 판단한다
        o.extra_yn = o.extra_yn ?? ((o.extra_works ?? []).length ? YN.YES : YN.NO);
        o.packing_yn = o.packing_yn ?? YN.NO;
        o.work_note = o.work_note ?? '';
        o.packing_note = o.packing_note ?? '';
        o.confirmed_at = o.confirmed_at ?? null;
        o.canceled_at = o.canceled_at ?? null;
        // 단계별 완료 시각 (없으면 미완료).
        // 조정작업처럼 `at` 이 없는 계산 단계는 건너뛴다 (o[undefined] 가 생긴다)
        WORK_STEPS.filter((step) => step.at).forEach((step) => {
            o[step.at] = o[step.at] ?? null;
        });
        o.ship_started_at = o.ship_started_at ?? null;
        o.packing_at = o.packing_at ?? null;
        // 검수완료 시 입력하는 실측값
        o.box_count = o.box_count ?? 0;
        // 상차까지 끝난 뒤 용마담당자가 찍는 최종 완료처리
        o.closed_at = o.closed_at ?? null;
        // 추가주문 묶음의 기준 번호 (1차수는 자기 주문번호와 같다)
        o.base_no = o.base_no ?? o.order_no;
        // 대표주문번호 - 여러 주문번호를 한 검수·상차 단위로 묶는다 (없으면 null)
        o.rep_no = String(o.rep_no ?? '').trim() || null;
        // 출고적치 - 파렛트 로케이션을 전량 입력하면 채워진다
        o.stow_done_at = o.stow_done_at ?? null;
        // 단계별 작업자 이름 (웹에서 직접 입력하거나 모바일 처리 시 자동으로 채워진다)
        o.ship_worker = o.ship_worker ?? '';
        o.inspect_worker = o.inspect_worker ?? '';
        o.extra_worker = o.extra_worker ?? '';
    });
    db.pallets.forEach((p) => {
        p.location = p.location ?? '';       // 출고적치 로케이션
        p.picked_at = p.picked_at ?? null;   // 적치 위치에서 내린 시각
    });
    db.history.forEach((h) => {
        h.checked_at = h.checked_at ?? null;
    });
    db.restores.forEach((r) => {
        r.checked_at = r.checked_at ?? null;
        r.category = r.category ?? 'etc';
    });
    return db;
}

/**
 * 전체 데이터를 읽는다. 어디에 저장되어 있는지는 `store.js` 가 안다.
 * 읽은 뒤 `normalize()` 로 누락 필드를 채운다.
 */
function load() {
    return loadDb(normalize);
}

/** 변경사항을 저장한다 */
function save(db) {
    return saveDb(db);
}

/** 저장 데이터를 시드 상태로 되돌린다 (mock 모드 전용) */
export async function resetDb() {
    return storeReset();
}

/* ------------------- 묶음 (일괄 처리 = 대표주문번호 / 상차 = 대표주문번호 · 차수) ------------------- */

/**
 * 상차 묶음 키 🔑 (상차대기 · 상차리스트 · 상차검수 · 상차라벨 전용)
 * 대표주문번호 > 차수 기준번호 > 주문번호 순으로 본다.
 *   rep_no  - 여러 주문번호를 한 검수·상차 단위로 묶는다 (선택 입력)
 *   base_no - 추가주문의 차수를 묶는다 (a11111 → a11111-1)
 * 두 묶음은 겹칠 수 있다. 겹치면 대표주문번호가 이긴다.
 *
 * ⚠️ 접수·출고작업·검수·패킹리스트·완료처리의 **일괄 처리 범위는 이 키가 아니다.**
 * 그쪽은 대표주문번호가 있을 때만 묶는다 (`repKeyOf` · `batchGroupOf` 참고).
 */
export function groupKeyOf(o) {
    return o.rep_no || o.base_no || o.order_no;
}

/**
 * 일괄 처리 묶음 키 🔑 (접수 · 출고작업 · 검수작업 · 패킹리스트 · 완료처리)
 * **대표주문번호가 있을 때만 묶는다.** 없으면 주문 1건이 곧 하나의 묶음이다.
 * 추가주문 차수(`base_no`)는 여기서 묶지 않는다 - 차수마다 따로 처리한다.
 */
function repKeyOf(o) {
    return o.rep_no || `#${o.id}`;
}

/**
 * 묶음 대표(head) 정렬 규칙.
 * (1) 주문번호가 대표주문번호와 같은 건 → (2) 먼저 등록된 건 → (3) 낮은 차수.
 * 차수 묶음만 있을 때는 1차수가 대표가 된다.
 */
function compareHead(a, b) {
    const isRep = (o) => (o.rep_no && o.order_no === o.rep_no ? 0 : 1);
    if (isRep(a) !== isRep(b)) return isRep(a) - isRep(b);
    const at = String(a.created_at ?? '');
    const bt = String(b.created_at ?? '');
    if (at !== bt) return at < bt ? -1 : 1;
    if ((a.seq ?? 1) !== (b.seq ?? 1)) return (a.seq ?? 1) - (b.seq ?? 1);
    // 같은 시각·같은 차수면 id 로 순서를 고정한다.
    // (서버 조회는 정렬을 보장하지 않아 대표가 화면마다 달라질 수 있다)
    return String(a.id).localeCompare(String(b.id));
}

/**
 * 넘긴 목록을 키별로 묶는다.
 * ⚠️ **취소건을 걸러내지 않는다.** 넘기는 쪽이 정한다
 *    (주문정보등록 목록은 취소건도 보여주고, 처리 화면은 미리 걸러서 넘긴다).
 * 묶음 순서는 넘긴 목록에서 처음 나온 순서를 그대로 따른다.
 * @returns {Array<{key:string, head:object, rows:object[]}>}
 */
function groupList(rows, keyOf) {
    const map = new Map();
    rows.forEach((o) => {
        const key = keyOf(o);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(o);
    });
    return [...map.entries()].map(([key, list]) => {
        const sorted = [...list].sort(compareHead);
        return { key, head: sorted[0], rows: sorted };
    });
}

/**
 * 대표주문번호 묶음 목록 (주문정보등록 · 출고주문처리 웹 목록에서 1행으로 접을 때 쓴다).
 * 대표주문번호가 없는 주문은 자기 혼자 1묶음이다.
 */
export function repGroups(rows) {
    return groupList(rows, repKeyOf);
}

/** 상차 묶음 목록 (상차대기 · 상차라벨 - 추가주문 차수까지 함께 묶는다) */
export function loadGroups(rows) {
    return groupList(rows, groupKeyOf);
}

/**
 * 일괄 처리 묶음 🔑
 * 접수 · 출고작업 · 검수작업 · 패킹리스트 · 완료처리의 적용 범위다.
 * **대표주문번호가 있을 때만 묶고**, 없으면 주문 1건만 담는다.
 * @param {boolean} canceled 취소건까지 담을지 (상세 팝업의 묶인 주문번호 표에서만 쓴다)
 * @returns {{key:string, head:object, rows:object[]}|null}
 */
function batchGroupOf(db, orderId, canceled = false) {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return null;
    if (!o.rep_no) return { key: repKeyOf(o), head: o, rows: [o] };
    const rows = db.orders
        .filter((x) => repKeyOf(x) === repKeyOf(o) && (canceled || !x.canceled_at))
        .sort(compareHead);
    return { key: repKeyOf(o), head: rows[0] ?? o, rows: rows.length ? rows : [o] };
}

/**
 * 일괄 처리 대상 (처리 함수 공통 진입점).
 * @returns {{rows:object[], head:object}}
 */
function groupFor(db, id) {
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    const g = batchGroupOf(db, id);
    return { rows: g.rows, head: g.head };
}

/** 이 주문이 대표주문번호 묶음의 대표인지 (묶이지 않은 주문은 언제나 대표다) */
function isBatchHead(db, o) {
    return batchGroupOf(db, o.id)?.head.id === o.id;
}

/** 주문번호 나열 (오류 메시지·안내 문구에 쓴다) */
function nosOf(rows) {
    return rows.map((r) => r.order_no).join(', ');
}

/** 그 주문이 **자기 총량**(파렛트수·박스수)을 갖고 있는지 */
function hasOwnCount(o) {
    return Number(o?.pallet_count ?? 0) > 0 || Number(o?.box_count ?? 0) > 0;
}

/**
 * 묶음 종류 판정 🔑 — **주문마다 자기 파렛트·자기 라벨을 가진 묶음인가**
 *
 * 묶음에는 두 종류가 있고 총량이 실린 곳이 다르다. 둘 다 정상이다.
 *   등록 시 대표주문번호로 묶음 - 검수 시 총량을 **대표에 1회** 입력 → 멤버는 0파렛트·0박스
 *   검수 후 합침(`mergeOrders`) - **멤버마다 자기 총량**을 그대로 들고 온다
 * 판정 기준은 **자기 총량을 가진 멤버가 2건 이상인가** 하나뿐이다.
 * 파렛트수만 보면 혼적(0파렛트·박스만 있는) 멤버가 빠져 판정이 뒤집힌다.
 *
 * ⚠️ **모집단은 부르는 쪽이 정한다.** 단계마다 묶음 범위가 다르기 때문이다.
 *   상차라벨 출력 · 총량 수정 → **대표주문번호 묶음** (`getBatchGroup` · `repGroups`)
 *   상차검수 안내          → **상차 묶음** (`getLoadGroup` · `loadGroups`)
 * @param {object[]} rows 묶음 멤버 (취소건은 미리 걸러서 넘긴다)
 */
export function hasSplitPallets(rows) {
    return (rows ?? []).filter(hasOwnCount).length > 1;
}

/**
 * `readyToLoad` 에 넘길 조건값을 만드는 함수를 돌려준다 🔑
 * 상차리스트(`listLoading`) · 상차완료(`completeLoading`) · 합치기 조건(④-2)이
 * **같은 기준**으로 단계 완료를 판단하도록 한곳에 모았다.
 * @returns {(o:object) => import('./steps.js').StepOpt}
 */
function stepOptOf(db) {
    const tasks = extraTaskNoSet(db);
    const adjust = {};
    db.restores.forEach((r) => {
        const m = (adjust[r.order_id] ??= { has: true, done: true });
        if (!r.checked_at) m.done = false;
    });
    return (o) => ({ task: tasks.has(o.order_no), adjust: adjust[o.id] });
}

/** 상차작업을 뺀 **미완료 단계 이름** 목록 (거부 사유에 적는다) */
function stepsLeft(o, opt) {
    return visibleSteps(o, opt)
        .filter((s) => s.key !== 'load' && !s.done)
        .map((s) => s.label);
}

/**
 * 상차 묶음에서 **상차 이외의 단계가 끝나지 않은 멤버**의 사유 🔑
 * 상차리스트의 막힘 표시(`listLoading` · `groupOf`)와 상차완료 거부(`completeLoading`)가
 * 같은 계산을 쓰도록 한곳에 모았다. 화면은 이 문구를 그대로 보여준다.
 * @returns {string} `주문번호 - 미완료단계·미완료단계` 형식. 전원 준비됐으면 빈 문자열
 */
function notReadyReason(rows, optOf) {
    return rows
        .filter((r) => !readyToLoad(r, optOf(r)))
        .map((r) => `${r.order_no} - ${stepsLeft(r, optOf(r)).join('·')}`)
        .join(', ');
}

/**
 * 검수용 파렛트 바코드를 파렛트 수만큼 만든다.
 * 상차 검수는 상차라벨(주문번호)을 스캔하지만, 파렛트 개별 바코드도 그대로 인식한다.
 */
function makePallets(orderRow) {
    const list = [];
    for (let i = 1; i <= orderRow.pallet_count; i += 1) {
        list.push({
            id: `${orderRow.id}_p${i}`,
            order_id: orderRow.id,
            barcode: `${orderRow.order_no}-P${String(i).padStart(2, '0')}`,
            scanned_at: null,
            location: '',
            picked_at: null,
        });
    }
    return list;
}

/**
 * 파렛트 수에 맞춰 상차 검수용 바코드를 다시 만든다.
 * 이미 진행한 상차 검수는 초기화된다 (바코드 자체가 바뀌기 때문이다).
 */
function rebuildPallets(db, o) {
    db.pallets = db.pallets.filter((p) => p.order_id !== o.id);
    o.inspected = 0;
    o.load_status = LOAD_STATUS.WAIT;
    db.pallets.push(...makePallets(o));
}

/** 이력에 표시할 값으로 변환한다 (배열은 쉼표로 합침) */
function toText(v) {
    return Array.isArray(v) ? v.join(', ') : String(v ?? '');
}

/**
 * 변동사항 히스토리 1건 기록
 * @param {number} rev 몇 번째 수정에서 발생했는지. 0 이면 수정이 아닌 이벤트(등록·삭제 등)
 */
function addHistory(db, orderId, field, before, after, user, memo = '', rev = 0) {
    db.history.push({
        id: uid('h'),
        order_id: orderId,
        field,
        rev,
        before: toText(before),
        after: toText(after),
        changed_by: user?.id ?? '',
        changed_by_name: user?.name ?? '',
        changed_at: new Date().toISOString(),
        memo,
        checked_at: null,      // 수정확인 일시 (null 이면 미확인)
        checked_by: null,
        checked_by_name: '',
    });
}

/* ---------------------------------- 사용자 ---------------------------------- */

export async function listUsers() {
    return (await load()).users;
}

export async function getUser(id) {
    return (await load()).users.find((u) => u.id === id) ?? null;
}

/** 사용자 권한 변경 (관리자 전용 화면에서 호출) */
export async function updateUserRole(id, role) {
    const db = (await load());
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('사용자를 찾을 수 없습니다.');
    u.role = role;
    await save(db);
    return u;
}

/** 사용자 소속 변경 (주문정보등록 화면의 권한이 소속에 따라 달라진다) */
export async function updateUserCompany(id, company) {
    const db = (await load());
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('사용자를 찾을 수 없습니다.');
    u.company = company;
    await save(db);
    return u;
}

/** 사용자 사용여부 토글 */
export async function toggleUserActive(id) {
    const db = (await load());
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('사용자를 찾을 수 없습니다.');
    u.active = !u.active;
    await save(db);
    return u;
}

/**
 * 사용자 신규 등록 (관리자 전용).
 * Supabase 모드에서는 서버 함수가 로그인 계정·프로필을 한 번에 만든다.
 * payload 에 password 가 포함되어야 한다.
 */
export async function createUser(payload) {
    if (isSupabase) {
        const { error } = await supabase().rpc('admin_create_user', {
            p_name: payload.name,
            p_email: payload.email,
            p_password: payload.password,
            p_company: payload.company,
            p_role: payload.role,
            p_phone: payload.phone ?? '',
        });
        if (error) throw new Error(error.message);
        invalidate();
        return null;
    }
    const db = (await load());
    const row = { id: uid('u'), active: true, ...payload };
    db.users.push(row);
    await save(db);
    return row;
}

/**
 * 사용자 정보 수정 (관리자 전용).
 * 이메일은 로그인 ID 라 서버 함수가 auth 쪽까지 함께 고친다.
 */
export async function updateUser(id, patch) {
    if (!isSupabase) {
        const db = (await load());
        const u = db.users.find((x) => x.id === id);
        if (!u) throw new Error('사용자를 찾을 수 없습니다.');
        Object.assign(u, patch);
        await save(db);
        return u;
    }
    const { error } = await supabase().rpc('admin_update_user', {
        target: id,
        p_name: patch.name,
        p_email: patch.email,
        p_phone: patch.phone ?? '',
        p_company: patch.company,
        p_role: patch.role,
    });
    if (error) throw new Error(error.message);
    invalidate();
    return (await getUser(id));
}

/**
 * 비밀번호 초기화 (관리자 전용).
 * `config.INITIAL_PASSWORD` 로 되돌린다. 사용자에게 이 값을 알려주고 바꾸게 한다.
 */
export async function resetUserPassword(id) {
    if (!isSupabase) throw new Error('mock 모드에서는 비밀번호를 다룰 수 없습니다.');
    const { error } = await supabase().rpc('admin_reset_password', {
        target: id, new_pw: INITIAL_PASSWORD,
    });
    if (error) throw new Error(error.message);
    return INITIAL_PASSWORD;
}

/**
 * 사용자 삭제 (관리자 전용).
 * 로그인 계정까지 함께 지운다. **등록한 주문이 남아 있으면 서버가 거부한다.**
 */
export async function deleteUser(id) {
    if (!isSupabase) {
        const db = (await load());
        db.users = db.users.filter((u) => u.id !== id);
        await save(db);
        return;
    }
    const { error } = await supabase().rpc('admin_delete_user', { target: id });
    if (error) throw new Error(error.message);
    invalidate();
}

/* ----------------------------------- 주문 ----------------------------------- */

/**
 * 주문 목록 조회
 * @param {{from?:string, to?:string, keyword?:string, createdBy?:string,
 *          shipDate?:string}} f 필터
 */
export async function listOrders(f = {}) {
    const db = (await load());
    let rows = [...db.orders];
    if (f.createdBy) rows = rows.filter((o) => o.created_by === f.createdBy);
    if (f.from) rows = rows.filter((o) => o.reg_date >= f.from);
    if (f.to) rows = rows.filter((o) => o.reg_date <= f.to);
    if (f.shipDate) rows = rows.filter((o) => o.ship_req_date === f.shipDate);
    if (f.keyword) {
        const k = f.keyword.trim().toLowerCase();
        rows = rows.filter(
            (o) => `${o.order_no} ${o.rep_no ?? ''} ${o.customer}`.toLowerCase().includes(k),
        );
    }
    rows.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    return rows;
}

/**
 * 추가주문을 붙일 수 있는 주문번호 목록.
 * **종결된 주문(완료처리·취소)은 제외한다.**
 * 주문번호별로 최신 차수 정보만 돌려준다.
 */
export async function listOpenOrderNos(f = {}) {
    const db = (await load());
    const map = new Map();
    db.orders
        .filter((o) => !o.closed_at && !o.canceled_at)
        .filter((o) => !f.createdBy || o.created_by === f.createdBy)
        .forEach((o) => {
            const base = o.base_no ?? o.order_no;
            const cur = map.get(base);
            if (!cur || o.seq > cur.seq) {
                map.set(base, {
                    base_no: base,
                    order_no: base,             // 목록에는 기준(1차수) 번호를 보여준다
                    next_no: `${base}-${o.seq}`, // 다음 차수에 붙일 주문번호 제안
                    customer: o.customer,
                    seq: o.seq,
                    vehicle_type: o.vehicle_type,
                    ship_req_date: o.ship_req_date,
                });
            }
        });
    return [...map.values()].sort((a, b) => a.order_no.localeCompare(b.order_no));
}

/**
 * 🔑 대표주문번호 묶음은 **같은 등록자의 주문만** 묶을 수 있다.
 * 화주영업팀은 본인 등록건만 보이므로(`viewAll` 없음) 남의 주문이 섞이면 묶음이
 * 사람마다 다르게 보이고 일괄 처리 범위도 어긋난다. 그래서 등록자를 맞춘다.
 * 이 검사는 화면에 보이는 행만 보므로, 서버의 `enforce_rep_owner` 트리거가 최종 판정이다.
 * @param {string|null} repNo 붙이려는 대표주문번호
 * @param {{id:string}} owner 묶음에 들어갈 주문의 등록자
 * @param {string} [excludeId] 수정 중인 주문 자신
 */
function assertRepOwner(db, repNo, owner, excludeId) {
    if (!repNo) return;
    const other = db.orders.find((x) => x.rep_no === repNo && x.id !== excludeId
        && x.created_by !== owner?.id);
    if (other) {
        throw new Error(`대표주문번호 '${repNo}' 는 다른 담당자가 등록한 묶음입니다. `
            + '같은 담당자가 등록한 주문만 묶을 수 있습니다.');
    }
}

/**
 * 등록 폼에서 제안할 대표주문번호 목록.
 * **종결된 주문(완료처리·취소)은 제외한다.**
 * 🔑 **상차검수가 시작된 묶음도 뺀다.** 라벨을 읽기 시작한 뒤에 멤버가 늘면 묶음 진행률과
 * 실제 스캔 수가 어긋나 그 묶음 전체가 상차리스트에서 사라진다 (`mergeBlockReason` 과
 * 같은 기준이다). 취소된 멤버는 묶음에서 빠지므로 판정에 넣지 않는다.
 * @returns {Promise<Array<{rep_no:string, customer:string, count:number}>>}
 */
export async function listOpenRepNos(f = {}) {
    const db = (await load());
    const closedReps = new Set(db.orders
        .filter((o) => o.rep_no && !o.canceled_at && mergeBlockReason(o))
        .map((o) => o.rep_no));
    const map = new Map();
    db.orders
        .filter((o) => o.rep_no && !o.closed_at && !o.canceled_at)
        .filter((o) => !closedReps.has(o.rep_no))
        .filter((o) => !f.createdBy || o.created_by === f.createdBy)
        .forEach((o) => {
            const cur = map.get(o.rep_no)
                ?? { rep_no: o.rep_no, customer: o.customer, created_by: o.created_by, count: 0 };
            cur.count += 1;
            map.set(o.rep_no, cur);
        });
    return [...map.values()].sort((a, b) => a.rep_no.localeCompare(b.rep_no));
}

/**
 * 등록·수정 폼에서 **대표주문번호를 직접 지정할 때**의 검사 🔑
 * 합치기(`mergeOrders`)와 **같은 기준**(`mergeBlockReason`)으로 기존 묶음 멤버를 본다.
 * 상차검수가 시작된 묶음에 주문이 하나 끼면 묶음 진행률과 실제 스캔 수가 어긋나,
 * 데이터는 멀쩡한데 그 묶음 전체가 상차리스트에서 빠지고 상차완료가 영구 거부된다.
 * @param {string|null} repNo 붙이려는 대표주문번호
 * @param {string} [excludeId] 수정 중인 주문 자신
 */
function assertRepJoinable(db, repNo, excludeId) {
    if (!repNo) return;
    const blocked = repBlockedMember(db, repNo, excludeId);
    if (blocked) {
        throw new Error(`대표주문번호 '${repNo}' 묶음에는 더 넣을 수 없습니다. `
            + `(${blocked.order_no} - ${blocked.reason})`);
    }
}

/**
 * 묶음에 더 넣지 못하게 만드는 멤버 1건 (없으면 null).
 * 취소된 멤버는 묶음에서 빠지므로 보지 않는다.
 * @returns {{order_no:string, reason:string}|null}
 */
function repBlockedMember(db, repNo, excludeId) {
    const hit = db.orders
        .filter((x) => x.rep_no === repNo && x.id !== excludeId && !x.canceled_at)
        .map((x) => ({ order_no: x.order_no, reason: mergeBlockReason(x) }))
        .find((x) => x.reason);
    return hit ?? null;
}

/**
 * 일괄등록 검증용 - **더 넣을 수 없는** 대표주문번호와 사유.
 * `listOpenRepNos` 가 후보에서 뺀 묶음과 같은 기준이다 (판정은 `mergeBlockReason` 하나).
 * @returns {Promise<Array<{rep_no:string, order_no:string, reason:string}>>}
 */
export async function listBlockedRepNos(f = {}) {
    const db = (await load());
    const mine = db.orders.filter((o) => !f.createdBy || o.created_by === f.createdBy);
    return [...new Set(mine.filter((o) => o.rep_no).map((o) => o.rep_no))]
        .map((repNo) => ({ repNo, hit: repBlockedMember(db, repNo) }))
        .filter((x) => x.hit)
        .map((x) => ({ rep_no: x.repNo, ...x.hit }));
}

/* ------------------------------ 주문합치기 (대표주문번호) ------------------------------ */

/**
 * 주문합치기 허용 조건 🔑 — 주문 1건만 보고 판단하는 부분 (③ ④).
 * ③ 취소·완료처리·상차완료된 주문은 더 이상 묶음을 바꾸지 않는다.
 * ④ 🔑 **상차검수 전에만 합친다.** 실무에서는 검수작업이 끝난 뒤에 합치는 경우가
 *    더 많다. 파렛트는 각 주문이 검수한 수량 그대로 두고(재입력 없음), 상차검수에서
 *    주문별 라벨을 각각 스캔한다 (`scanPallet`). 다만 라벨을 이미 읽기 시작한 뒤에
 *    멤버가 늘면 묶음 진행률과 실제 스캔 수가 어긋나므로 그때부터는 막는다.
 * @returns {string} 사유. 합칠 수 있으면 빈 문자열
 */
function mergeBlockReason(o) {
    if (o.canceled_at) return '취소된 주문은 합칠 수 없습니다.';
    if (o.closed_at) return '완료처리된 주문은 합칠 수 없습니다.';
    if (loadDone(o)) return '상차완료된 주문은 합칠 수 없습니다.';
    if (Number(o.inspected ?? 0) > 0 || o.load_status !== LOAD_STATUS.WAIT || o.loaded_at) {
        return '상차검수가 시작된 주문은 합칠 수 없습니다. '
            + '상차검수를 초기화한 뒤 합치세요.';
    }
    return '';
}

/**
 * ④-2 에서 **유무가 같아야 하는 단계** 🔑
 * 진행 단계가 다른 주문이 한 묶음이 되면 `completeLoading` 이 묶음 전체에 `loaded_at` 을
 * 찍어 검수·적치를 건너뛴 주문까지 상차완료·마감된다. 단계 이름은 `config.js` 가 출처다.
 */
const MERGE_STEP_FIELDS = ['inspect_done_at', 'stow_done_at', 'extra_done_at'];

/**
 * 넘긴 주문들이 속한 **상차 묶음 전체**를 중복 없이 펼친다 🔑
 * 합치면 한 상차 묶음이 되는 범위는 `groupOf`(대표주문번호 ∪ 차수 기준번호)다.
 * 대표주문번호 묶음(`batchGroupOf`)만 비교하면 상대에게 딸린 **추가주문 차수**가
 * 비교되지 않은 채 같은 상차 묶음으로 들어온다.
 */
function loadRowsOf(db, rows) {
    const map = new Map();
    rows.forEach((r) => (groupOf(db, r.id)?.rows ?? [r])
        .forEach((x) => map.set(x.id, x)));
    return [...map.values()];
}

/**
 * ④-2 판정 🔑 - 합치면 한 상차 묶음이 될 주문 **전부**의 진행 단계가 같아야 한다.
 * 비교 기준은 `readyToLoad` 가 보는 것과 같다 (검수·적치·추가작업·조정요청 확인).
 * @returns {string} 사유. 어긋나지 않으면 빈 문자열
 */
function stepGapReason(db, o, tRows) {
    const all = loadRowsOf(db, [o, ...tRows]);
    const gap = MERGE_STEP_FIELDS.find((field) => {
        const yes = all.filter((r) => Boolean(r[field])).length;
        return yes > 0 && yes < all.length;
    });
    if (gap) {
        const label = WORK_STEPS.find((s) => s.at === gap)?.label ?? gap;
        const done = all.filter((r) => r[gap]);
        const left = all.filter((r) => !r[gap]);
        return `${label} 진행 상태가 다른 주문끼리는 합칠 수 없습니다.`
            + ` (완료 ${nosOf(done)} / 미완료 ${nosOf(left)})`;
    }
    // 추가작업 요청·조정요청 확인까지 본다 (`listLoading` · `completeLoading` 과 같은 기준)
    const optOf = stepOptOf(db);
    const ready = all.filter((r) => readyToLoad(r, optOf(r)));
    if (!ready.length || ready.length === all.length) return '';
    const left = all.filter((r) => !ready.includes(r))
        .map((r) => `${r.order_no} - ${stepsLeft(r, optOf(r)).join('·')}`);
    return '상차 준비 상태가 다른 주문끼리는 합칠 수 없습니다.'
        + ` (남은 단계: ${left.join(', ')})`;
}

/**
 * 합치기 출발점으로 쓸 수 있는 주문인지 (⑤ 포함).
 * ⑤ 🔑 **이미 어느 묶음에도 속하지 않은 주문만** 출발점이 된다.
 *    묶인 주문을 다른 묶음으로 옮기면 남은 멤버의 처리 범위가 조용히 바뀐다.
 * @returns {string} 사유. 합칠 수 있으면 빈 문자열
 */
function mergeSourceBlockReason(o) {
    if (o.rep_no) {
        return `이미 대표주문번호 '${o.rep_no}' 묶음에 속한 주문입니다. `
            + '수정 폼에서 대표주문번호를 비운 뒤 다시 합치세요.';
    }
    return mergeBlockReason(o);
}

/** 차수 기준번호 (옛 데이터는 `base_no` 가 없어 주문번호로 본다) */
function baseNoOf(o) {
    return o.base_no || o.order_no;
}

/**
 * 두 주문을 짝지어 판단하는 조건 (① ② ④-2 ⑥ ⑦ ⑧).
 * @param {object} db 저장소 스냅샷 (④-2 가 상차 묶음을 펼쳐 본다)
 * @param {object} o 합치려는 주문 (출발점)
 * @param {object} t 합칠 상대
 * @param {object[]} tRows 상대가 이미 속한 묶음 전체 (④-2 ⑥ 은 묶음 멤버 전부와 비교한다)
 * @returns {string} 사유. 합칠 수 있으면 빈 문자열
 */
function mergePairBlockReason(db, o, t, tRows = [t]) {
    if (o.id === t.id) return '같은 주문끼리는 합칠 수 없습니다.';
    if (o.customer !== t.customer) return '거래처가 다른 주문은 합칠 수 없습니다.';
    if (o.created_by !== t.created_by) {
        return '등록자가 다른 주문은 합칠 수 없습니다. '
            + '같은 담당자가 등록한 주문만 묶을 수 있습니다.';
    }
    if ((o.ship_req_date ?? '') !== (t.ship_req_date ?? '')) {
        return '출고요청일이 다른 주문은 합칠 수 없습니다. '
            + '묶인 주문은 같은 날 함께 실립니다.';
    }
    // ④-2 검수·적치·추가작업의 진행 상태가 같아야 한다. 비교 모집단은 **상차 묶음**이라
    //     상대에게 딸린 추가주문 차수까지 함께 본다 (`stepGapReason`).
    //     단계를 건너뛴 주문이 묶음 전체의 상차완료에 딸려 올라가는 것을 막는다
    const gap = stepGapReason(db, o, tRows);
    if (gap) return gap;
    // ⑥ 차수 형제는 이미 상차 묶음(`base_no`)으로 함께 실린다. 대표주문번호로 또 묶으면
    //    출고작업·검수작업까지 묶여 나중에 합류한 차수가 영구 차단된다.
    //    상대가 이미 묶여 있으면 그 묶음 멤버 전부와 비교한다 (우회로를 막는다)
    if (tRows.some((r) => baseNoOf(o) === baseNoOf(r))) {
        return '같은 주문의 추가 차수끼리는 합칠 수 없습니다. '
            + '차수는 상차 단계에서 이미 함께 묶입니다.';
    }
    // ⑧ 상대가 아직 묶이지 않았다면 그 주문번호가 대표가 되므로 1차수여야 한다
    if (!t.rep_no && (t.seq ?? 1) !== 1) {
        return '아직 묶이지 않은 추가주문(2차수 이상)은 합칠 상대가 될 수 없습니다. '
            + '1차수 주문이나 이미 묶인 주문을 고르세요.';
    }
    return '';
}

/**
 * 이 주문을 합치기 출발점으로 쓸 수 있는지 (화면의 안내 문구용).
 * @returns {Promise<string>} 사유. 합칠 수 있으면 빈 문자열
 */
export async function mergeSourceReason(orderId) {
    const o = (await load()).orders.find((x) => x.id === orderId);
    if (!o) return '주문을 찾을 수 없습니다.';
    return mergeSourceBlockReason(o);
}

/**
 * 주문합치기 대상 후보 목록 🔑
 * 허용 조건(①~⑧)을 모두 만족하는 주문만 돌려준다. 조건에 걸린 주문은 아예 담지 않는다.
 * 새 묶음 개념을 만들지 않고 기존 대표주문번호(`rep_no`) 묶음에 넣는 것이므로,
 * 후보마다 그 후보가 이미 속한 묶음 정보(`group_no` `group_count` `group_nos`)와
 * **합쳤을 때의 대표주문번호(`merge_rep_no`)** 를 붙인다.
 *
 * ⚠️ 검색어 필터는 하지 않는다. 화면이 입력할 때마다 실시간으로 거른다.
 * @param {string} orderId 합치려는 주문
 * @returns {Promise<Array<object>>} 최근 등록순
 */
export async function listMergeTargets(orderId) {
    const db = (await load());
    const cur = db.orders.find((x) => x.id === orderId);
    if (!cur || mergeSourceBlockReason(cur)) return [];

    return db.orders
        .filter((o) => !mergeBlockReason(o))
        .map((o) => ({ row: o, rows: batchGroupOf(db, o.id)?.rows ?? [o] }))
        // 상대가 이미 묶여 있으면 묶음 멤버 전부가 ③④ 를 만족해야 한다
        // (④-2 단계 일치는 `mergePairBlockReason` 이 멤버 전부와 비교한다)
        .filter(({ row, rows }) => !mergePairBlockReason(db, cur, row, rows)
            && !rows.some((r) => mergeBlockReason(r)))
        .map(({ row, rows }) => ({
            ...row,
            group_no: row.rep_no || row.order_no,
            group_count: rows.length,
            group_nos: rows.map((r) => r.order_no),
            // 총량은 저장값이 아니라 **묶음 합계**로 읽는다 (묶음 종류가 둘이기 때문이다)
            group_pallets: rows.reduce((a, r) => a + Number(r.pallet_count ?? 0), 0),
            group_boxes: rows.reduce((a, r) => a + Number(r.box_count ?? 0), 0),
            // 이 후보를 고르면 정해질 대표주문번호 (화면은 이 값만 쓴다)
            merge_rep_no: row.rep_no || row.order_no,
        }))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

/**
 * 주문합치기 🔑
 * 현재 주문(`orderId`)을 대상 주문(`targetOrderId`)의 **대표주문번호 묶음**에 넣는다.
 * 대상에 대표주문번호가 없으면 대상의 주문번호를 대표주문번호로 삼고 대상에도 기록한다
 * (그래야 묶음이 성립한다).
 *
 * 허용 조건은 `mergeSourceBlockReason` · `mergeBlockReason` · `mergePairBlockReason`
 * 세 함수가 나눠 갖는다 (후보 목록도 같은 함수를 쓴다).
 * ⚠️ 차수(`base_no` `seq`)는 건드리지 않는다. 차수는 추가주문 개념이라 대표주문번호와 무관하다.
 * ⚠️ **파렛트도 건드리지 않는다.** 각 주문이 검수한 `pallet_count` · `box_count` 와
 *    파렛트 레코드를 그대로 유지한다. 묶음 총량은 저장값이 아니라 **묶음 합계**로 읽는다.
 * @returns {Promise<{rep_no:string, rows:object[]}>} 합친 뒤의 묶음
 */
export async function mergeOrders(orderId, targetOrderId, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === orderId);
    const t = db.orders.find((x) => x.id === targetOrderId);
    if (!o || !t) throw new Error('주문을 찾을 수 없습니다.');
    const tRows = batchGroupOf(db, t.id)?.rows ?? [t];
    const blocked = mergeSourceBlockReason(o) || mergeBlockReason(t)
        || mergePairBlockReason(db, o, t, tRows)
        // 묶음 멤버 중 하나라도 상차검수를 시작했으면 진행률이 어긋난다 (④)
        || tRows.map(mergeBlockReason).find(Boolean) || '';
    if (blocked) throw new Error(blocked);

    // 대상에 대표주문번호가 있으면 그 값, 없으면 대상의 주문번호를 대표로 삼는다
    const repNo = t.rep_no || t.order_no;
    assertRepOwner(db, repNo, { id: o.created_by }, o.id);

    // 🔑 수정 폼에서 대표주문번호를 바꿀 때와 같이 `edit_count` 기반 rev 로 남긴다.
    //    rev 가 0 이면 용마담당자의 수정확인 대상(`checkStats` 의 rev > 0)에서 빠진다
    if (!t.rep_no) {
        t.edit_count = (t.edit_count ?? 0) + 1;
        addHistory(db, t.id, '대표주문번호', '', repNo, user,
            `${o.order_no} 와 합침`, t.edit_count);
        t.rep_no = repNo;
    }
    o.edit_count = (o.edit_count ?? 0) + 1;
    addHistory(db, o.id, '대표주문번호', '', repNo, user,
        `${t.order_no} 와 합침`, o.edit_count);
    o.rep_no = repNo;

    await save(db);
    return { rep_no: repNo, rows: batchGroupOf(db, o.id)?.rows ?? [o] };
}

export async function getOrder(id) {
    return (await load()).orders.find((o) => o.id === id) ?? null;
}

/**
 * 주문 등록.
 * 차수는 '추가주문' 으로 등록할 때만 올라간다 (아래 주석 참고).
 */
export async function createOrder(payload, user) {
    const db = (await load());
    // 차수는 '추가주문' 으로 등록할 때만 올라간다.
    // 같은 주문번호라고 자동으로 올리지 않는다 (등록 화면에서 명시적으로 고른다).
    const { addition, base_no: baseNo, ...rest } = payload;
    // 대표주문번호는 선택 입력이다. 빈 값은 null 로 저장한다
    rest.rep_no = String(rest.rep_no ?? '').trim() || null;
    assertRepOwner(db, rest.rep_no, user);
    assertRepJoinable(db, rest.rep_no);
    // 추가주문은 기준 번호(1차수 주문번호)로 묶는다. 주문번호 자체는 `a11111-1` 처럼 따로 붙는다.
    const base = addition ? (baseNo || rest.order_no) : rest.order_no;
    const same = db.orders.filter((o) => o.base_no === base);
    if (addition && !same.length) {
        throw new Error('추가주문할 기존 주문번호를 찾을 수 없습니다.');
    }
    const seq = addition ? Math.max(...same.map((o) => o.seq)) + 1 : 1;
    const row = {
        id: uid('o'),
        reg_date: today(),
        seq,
        inspected: 0,
        load_status: LOAD_STATUS.WAIT,
        item_count: 0,
        qty: 0,
        pallet_count: 0,
        extra_works: [],
        team_name: '',
        region: '국내',
        extra_yn: YN.NO,
        packing_yn: YN.NO,
        work_note: '',
        packing_note: '',
        edit_count: 0,
        confirmed_at: null,
        canceled_at: null,
        ship_started_at: null,
        ship_done_at: null,
        req_work_at: null,
        packing_at: null,
        inspect_done_at: null,
        extra_done_at: null,
        loaded_at: null,
        ship_worker: '',
        inspect_worker: '',
        extra_worker: '',
        created_by: user.id,
        created_at: new Date().toISOString(),
        base_no: base,
        rep_no: null,
        ...rest,
    };
    db.orders.push(row);
    db.pallets.push(...makePallets(row));
    addHistory(db, row.id, '등록', '', `${row.order_no} (${seq}차수)`, user);
    await save(db);
    return row;
}

/** 주문 변동사항 수정 - 변경된 항목마다 히스토리를 남긴다 */
export async function updateOrder(id, patch, user, memo = '') {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    // 대표주문번호는 빈 값이면 묶음 해제(null)로 다룬다
    if ('rep_no' in patch) {
        patch.rep_no = String(patch.rep_no ?? '').trim() || null;
        // 묶음의 등록자는 원래 주문의 등록자로 본다 (수정하는 사람이 아니다)
        if (patch.rep_no !== o.rep_no) {
            assertRepOwner(db, patch.rep_no, { id: o.created_by }, o.id);
            assertRepJoinable(db, patch.rep_no, o.id);
        }
    }
    const labels = {
        send_date: '전송일자', order_no: '주문번호', rep_no: '대표주문번호', customer: '거래처명',
        ship_req_date: '출고요청일', vehicle_type: '출고형태', team_name: '팀명',
        region: '구분', extra_yn: '추가작업', packing_yn: '패킹리스트', work_note: '작업지시',
        packing_note: '패킹리스트 내용',
        extra_works: '추가작업', request_note: '요청사항', remark: '비고',
        item_count: '품목수', qty: '출고수량', pallet_count: '파렛트수', box_count: '박스수',
    };
    // 실제로 값이 바뀐 항목만 추린다. 한 번의 수정은 여러 항목이 바뀌어도 1회로 센다.
    const changed = Object.entries(patch)
        .filter(([k, v]) => toText(o[k]) !== toText(v));
    if (changed.length) {
        o.edit_count = (o.edit_count ?? 0) + 1;
        changed.forEach(([k, v]) => {
            addHistory(db, id, labels[k] ?? k, o[k], v, user, memo, o.edit_count);
            o[k] = v;
        });
    }
    // 파렛트 수가 바뀌면 검수 바코드를 재생성한다
    if ('pallet_count' in patch) rebuildPallets(db, o);
    await save(db);
    return o;
}

export async function deleteOrder(id, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) return;
    db.orders = db.orders.filter((x) => x.id !== id);
    db.pallets = db.pallets.filter((p) => p.order_id !== id);
    addHistory(db, id, '삭제', o.order_no, '', user);
    await save(db);
}

/* ------------------------------ 출고 처리 단계 ------------------------------ */

/** 단계별 작업자 필드명 */
const WORKER_FIELD = {
    ship: 'ship_worker',
    inspect: 'inspect_worker',
    extra: 'extra_worker',
};

/** 단계별 완료 시각 필드명 (작업자 기록 시 완료 여부 판단에 쓴다) */
const STEP_DONE_FIELD = {
    ship: 'ship_done_at',
    inspect: 'inspect_done_at',
    extra: 'extra_done_at',
};

/**
 * 모바일에서 주문번호를 스캔해 작업을 연 사람을 해당 단계의 작업자로 기록한다.
 * ⚠️ 이미 완료된 단계는 바꾸지 않는다. 실제로 작업한 사람 기록이 지워지면 안 된다.
 * @param {'ship'|'inspect'|'extra'} step 단계 키
 */
export async function recordWorker(orderId, step, user) {
    const field = WORKER_FIELD[step];
    if (!field || !user?.name) return null;
    const db = (await load());
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return null;
    if (o[STEP_DONE_FIELD[step]]) return o;   // 완료된 단계는 그대로 둔다
    if (o[field] === user.name) return o;
    o[field] = user.name;
    await save(db);
    return o;
}

/** 작업자가 비어 있으면 처리한 사람 이름으로 채운다 (스캔 없이 처리된 경우 대비) */
function fillWorker(o, step, user) {
    const field = WORKER_FIELD[step];
    if (field && !o[field]) o[field] = user?.name ?? '';
}

/**
 * 주문번호로 주문을 찾는다 (취소된 건은 제외).
 * **대표주문번호로도 찾는다.** 묶음 대표를 앞에 두고, 그다음 등록순·차수순이다.
 */
export async function findOrdersByNo(orderNo) {
    const key = String(orderNo).trim().toUpperCase();
    if (!key) return [];
    const db = (await load());
    const same = (v) => String(v ?? '').trim().toUpperCase() === key;
    return db.orders
        .filter((o) => !o.canceled_at && (same(o.order_no) || same(o.rep_no)))
        .sort((a, b) => {
            const ha = isBatchHead(db, a) ? 0 : 1;
            const hb = isBatchHead(db, b) ? 0 : 1;
            return ha === hb ? compareHead(a, b) : ha - hb;
        });
}

/** 단계 완료 시각을 설정하거나 지우고 이력에 남긴다 */
function setStepAt(db, o, field, label, done, user, memo = '') {
    o[field] = done ? new Date().toISOString() : null;
    addHistory(db, o.id, label, done ? '' : '완료', done ? '완료' : '취소', user, memo);
}

/** 출고작업 시작 - 대표주문번호 묶음이면 아직 시작하지 않은 멤버 전체에 적용된다 */
export async function startShipWork(id, user) {
    const db = (await load());
    const { rows, head } = groupFor(db, id);
    // 이미 끝낸 멤버는 건드리지 않는다 (뒤늦게 들어온 멤버만 시작할 수 있어야 한다)
    const targets = rows.filter((r) => !r.ship_done_at);
    if (!targets.length) throw new Error('이미 출고작업이 완료된 주문입니다.');
    const waiting = targets.filter((r) => !r.confirmed_at);
    if (waiting.length) {
        throw new Error(`접수되지 않은 주문이 있습니다 (${nosOf(waiting)}). `
            + '주문정보등록에서 접수 후 시작할 수 있습니다.');
    }
    const at = new Date().toISOString();
    targets.forEach((r) => {
        r.ship_started_at = at;
        fillWorker(r, 'ship', user);
        addHistory(db, r.id, '출고작업', '', '작업시작', user);
    });
    await save(db);
    return head;
}

/**
 * 출고작업 완료 / 완료 취소 - 대표주문번호 묶음이면 **아직 처리되지 않은 멤버만** 대상이다.
 * 🔑 이미 검수까지 끝난 멤버를 대상에서 빼야 뒤늦게 합류한 주문의 출고작업을 끝낼 수 있다.
 * (완료 취소는 작업시작만 한 건도 대상이다 - 화면의 `작업시작 취소` 가 이 경로를 쓴다)
 */
export async function setShipWorkDone(id, done, user) {
    const db = (await load());
    const { rows, head } = groupFor(db, id);
    const targets = done
        ? rows.filter((r) => !r.ship_done_at)
        : rows.filter((r) => r.ship_done_at || r.ship_started_at);
    if (!targets.length) {
        throw new Error(done
            ? '이미 출고작업이 완료된 주문입니다.'
            : '출고작업을 시작하지 않은 주문입니다.');
    }
    const waiting = targets.filter((r) => !r.confirmed_at);
    if (done && waiting.length) {
        throw new Error(`접수되지 않은 주문이 있습니다 (${nosOf(waiting)}). `
            + '주문정보등록에서 접수 후 완료할 수 있습니다.');
    }
    if (targets.some((r) => r.inspect_done_at)) {
        throw new Error(done
            ? '검수작업이 완료된 주문입니다. 검수를 먼저 취소하세요.'
            : '검수작업이 완료된 주문은 출고작업을 취소할 수 없습니다.');
    }
    const at = new Date().toISOString();
    targets.forEach((r) => {
        if (done && !r.ship_started_at) r.ship_started_at = at;
        if (done) fillWorker(r, 'ship', user);
        setStepAt(db, r, 'ship_done_at', '출고작업', done, user);
        if (!done) r.ship_started_at = null;
    });
    await save(db);
    return head;
}

/** 요청작업(추가작업) 대상인지 - 옛 데이터는 extra_works 배열로 판단한다 */
export function hasExtraWork(o) {
    return o.extra_yn === YN.YES || (o.extra_works ?? []).length > 0;
}

/**
 * 검수에서 받을 수 있는 최소 파렛트수.
 * 추가건(2차수 이상)은 기존 차수에 혼적할 수 있어 0파렛트를 허용한다.
 *
 * 🔑 **검수 후 합친 묶음(주문마다 자기 총량)에서는 0을 허용하지 않는다.**
 * 합친 주문은 자기 화물이 있어 0이 될 이유가 없고, 0으로 내리면 묶음 종류 판정이
 * 뒤집혀(`hasSplitPallets`) 총량 수정 대상이 대표로 옮겨간다.
 * @param {object[]} [rows] 그 주문이 속한 대표주문번호 묶음. 넘기지 않으면 종전 규칙
 */
export function minPalletOf(o, rows = null) {
    if (rows && hasSplitPallets(rows)) return 1;
    return o.seq > 1 ? 0 : 1;
}

/**
 * 검수작업 완료 / 완료 취소 🔑 **대표주문번호 묶음 전체에 한 번에 적용된다.**
 * (대표주문번호가 없으면 주문 1건만 처리한다 - 추가주문 차수는 차수마다 따로 검수한다)
 * 검수는 시작 개념 없이 완료만 처리한다.
 *
 * 총 파렛트수·박스수는 **묶음 총량을 1회 입력**받아 대표(head)에 저장하고,
 * 나머지 멤버는 0파렛트로 둔다 (혼적 추가건과 같은 처리 - 적치 단계도 함께 끝난다).
 * @param {{reqWork:boolean, palletCount:number, boxCount:number}} checks
 */
export async function setInspectDone(id, done, checks, user) {
    const db = (await load());
    const { rows, head } = groupFor(db, id);

    const notShipped = rows.filter((r) => !r.ship_done_at);
    if (done && notShipped.length) {
        throw new Error(`출고작업이 완료되지 않은 주문이 있습니다 (${nosOf(notShipped)}).`);
    }
    if (!done && rows.some((r) => loadDone(r))) {
        throw new Error('상차완료된 주문은 검수를 취소할 수 없습니다.');
    }
    // 다시 완료 처리하면 파렛트수 변경으로 상차검수가 초기화되어(rebuildPallets)
    // loaded_at 만 남고 load_status 가 '대기' 로 어긋난다. 상차를 먼저 되돌려야 한다
    if (done && rows.some((r) => loadDone(r))) {
        throw new Error('상차완료된 주문입니다. 상차리스트에서 상차완료를 먼저 취소하세요.');
    }
    // 적치가 끝난 주문은 순서대로 되돌린다. 적치를 남긴 채 검수만 취소하면
    // '검수 미완료 · 적치 완료' 라는 앞뒤 안 맞는 상태가 되고, 적치를 고칠 수도 없다.
    // 다시 완료 처리할 때도 같다 — 파렛트수가 바뀌면 rebuildPallets 가 로케이션을 지우는데
    // stow_done_at 만 남으면 '적치 완료 · 로케이션 0건' 이 된다 (대표주문번호 묶음에
    // 멤버가 늦게 합류해 재검수하는 경우에 실제로 도달한다)
    if (rows.some((r) => r.pallet_count && r.stow_done_at)) {
        throw new Error('출고적치가 완료된 주문입니다. 출고적치 탭에서 적치취소를 먼저 하세요.');
    }
    // 🔑 **검수 후 합친 묶음은 다시 검수완료할 수 없다.**
    // 총량을 대표에 몰아 싣고 `rebuildPallets` 가 멤버 파렛트를 지우므로, 주문마다 이미
    // 출력한 상차라벨이 조용히 폐기되고 묶음 총량도 대표 한 건 값으로 줄어든다.
    // 되돌리려면 수정 폼에서 대표주문번호를 비워 묶음을 푼 뒤 주문별로 검수한다
    if (done && hasSplitPallets(rows)) {
        throw new Error('검수 후에 합친 묶음입니다. 주문마다 파렛트수가 따로 있어 '
            + '묶음 총량을 다시 입력할 수 없습니다. 파렛트수·박스수는 각 주문의 '
            + '수정 버튼으로 고치고, 다시 검수하려면 수정 폼에서 대표주문번호를 비우세요.');
    }

    // 요청작업·패킹리스트는 묶음 중 하나라도 있으면 확인 대상이 된다
    const packings = rows.filter((r) => r.packing_yn === YN.YES);
    if (done && rows.some(hasExtraWork) && !checks.reqWork) {
        throw new Error('요청작업 확인을 체크해야 검수를 완료할 수 있습니다.');
    }
    // 패킹리스트는 별도 체크 없이 내용(packing_note)이 작성되어 있어야 완료로 본다
    if (done && packings.some((r) => !(r.packing_note ?? '').trim())) {
        throw new Error('패킹리스트를 먼저 작성해야 검수를 완료할 수 있습니다.');
    }

    // 검수 실측값 - 묶음 총 파렛트수와 총 박스수를 입력해야 완료할 수 있다
    if (done) {
        const pallet = Number(checks.palletCount);
        const box = Number(checks.boxCount);
        // 추가건(2차수 이상)은 기존 차수 파렛트에 혼적할 수 있어 0파렛트를 허용한다.
        // 입력값은 대표(head)에 실리므로 대표 기준으로 본다
        // (묶음 멤버는 아래에서 자동으로 0파렛트가 된다)
        const minPallet = minPalletOf(head, rows);
        if (!Number.isInteger(pallet) || pallet < minPallet) {
            throw new Error(minPallet === 0
                ? '총 파렛트수를 0 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.'
                : '총 파렛트수를 1 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.');
        }
        if (!Number.isInteger(box) || box < 1) {
            throw new Error('총 박스수를 1 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.');
        }
        const at = new Date().toISOString();
        rows.forEach((r) => {
            // 총량은 대표에 싣는다. 나머지 멤버는 0파렛트(혼적)로 둔다
            const count = r.id === head.id ? pallet : 0;
            const changed = r.pallet_count !== count;
            r.pallet_count = count;
            r.box_count = r.id === head.id ? box : 0;
            // 파렛트 수가 바뀌면 상차 검수 바코드를 그 수만큼 다시 만든다
            if (changed || !db.pallets.some((x) => x.order_id === r.id)) rebuildPallets(db, r);
            // 0파렛트 건은 적치할 파렛트가 없다. 출고적치 단계를 함께 끝낸다
            r.stow_done_at = count === 0 ? at : r.stow_done_at;
        });
    }

    rows.forEach((r) => {
        if (!done && !r.pallet_count) r.stow_done_at = null;   // 혼적 건은 적치도 함께 되돌린다
        if (done) fillWorker(r, 'inspect', user);
        if (hasExtraWork(r)) setStepAt(db, r, 'req_work_at', '요청작업', done, user);
        r.packing_at = done && r.packing_yn === YN.YES ? new Date().toISOString() : null;
        setStepAt(db, r, 'inspect_done_at', '검수작업', done, user);
    });
    await save(db);
    return head;
}

/**
 * 총량(파렛트수·박스수)을 고칠 대상 주문 🔑 **조회 전용**
 *
 * 묶음 두 종류의 차이를 **이 함수 한 곳에서만** 흡수한다.
 *   등록 시 묶은 묶음 - 총량이 대표(head)에만 있다 → **대표**를 고친다
 *   검수 후 합친 묶음 - 주문마다 자기 총량이 있다 → **그 주문 자신**을 고친다
 *
 * 화면은 이 결과의 값을 **기본값으로 보여주고 이 `id` 로 저장**한다.
 * 그래야 보이는 값과 고쳐지는 값이 언제나 같다 (`setPalletCount` · `setBoxCount` 는
 * 넘긴 주문을 그대로 대상으로 삼는다).
 * @returns {Promise<{id:string, order_no:string, seq:number,
 *                     pallet_count:number, box_count:number}>}
 */
export async function countTarget(orderId) {
    const db = (await load());
    const g = batchGroupOf(db, orderId);
    if (!g) throw new Error('주문을 찾을 수 없습니다.');
    const mine = g.rows.find((r) => r.id === orderId) ?? g.head;
    const t = hasSplitPallets(g.rows) ? mine : g.head;
    return {
        id: t.id,
        order_no: t.order_no,
        seq: Number(t.seq ?? 1),                  // 혼적(0파렛트) 허용 판정에 쓴다
        pallet_count: Number(t.pallet_count ?? 0),
        box_count: Number(t.box_count ?? 0),
    };
}

/**
 * 총 박스수 수정 - 검수완료 뒤에도 고칠 수 있다.
 * 박스수는 표시·라벨·CSV 에만 쓰이고 다른 단계에 영향이 없다. 상차완료 전까지 허용한다.
 * ⚠️ **넘긴 주문을 그대로 고친다.** 어느 주문을 고칠지는 화면이 `countTarget` 으로 정한다.
 */
export async function setBoxCount(id, count, user) {
    const db = (await load());
    const target = db.orders.find((x) => x.id === id);
    if (!target) throw new Error('주문을 찾을 수 없습니다.');
    if (target.canceled_at) throw new Error('취소된 주문입니다.');
    if (!target.inspect_done_at) throw new Error('검수완료된 주문만 박스수를 고칠 수 있습니다.');
    if (loadDone(target)) throw new Error('상차완료된 주문은 박스수를 고칠 수 없습니다.');
    const box = Number(count);
    if (!Number.isInteger(box) || box < 1) throw new Error('총 박스수는 1 이상의 숫자로 입력하세요.');
    if (target.box_count === box) return target;
    addHistory(db, target.id, '박스수', target.box_count, box, user);
    target.box_count = box;
    await save(db);
    return target;
}

/**
 * 총 파렛트수 수정 - 검수완료·적치 뒤에도 고칠 수 있다.
 * 파렛트수는 상차 검수 바코드 수·적치 로케이션 수·라벨 매수를 정하므로 단계에 따라 제한한다.
 *   상차완료            → 거부 (상차완료 취소 먼저)
 *   상차검수 스캔 있음  → 거부 (상차검수 초기화 먼저 - 스캔 수와 파렛트수가 어긋나면 안 된다)
 *   그 외               → **기존 로케이션은 지키고 끝에서만** 늘리거나 줄인다
 * 줄일 때 사라질 파렛트에 로케이션이 있으면 `needConfirm` 오류를 던지고,
 * 화면이 확인을 받은 뒤 `{ confirmRemove: true }` 로 다시 부른다.
 *
 * ⚠️ **넘긴 주문을 그대로 고친다.** 어느 주문을 고칠지는 화면이 `countTarget` 으로 정한다.
 * @param {{confirmRemove?:boolean}} opt
 */
export async function setPalletCount(id, count, user, opt = {}) {
    const db = (await load());
    const target = db.orders.find((x) => x.id === id);
    if (!target) throw new Error('주문을 찾을 수 없습니다.');
    if (target.canceled_at) throw new Error('취소된 주문입니다.');
    if (!target.inspect_done_at) throw new Error('검수완료된 주문만 파렛트수를 고칠 수 있습니다.');
    if (loadDone(target)) throw new Error('상차완료된 주문은 파렛트수를 고칠 수 없습니다.');
    const mine = db.pallets.filter((x) => x.order_id === target.id)
        .sort((a, b) => a.barcode.localeCompare(b.barcode));
    if (mine.some((x) => x.scanned_at)) {
        throw new Error('상차검수가 진행된 주문입니다. 상차검수를 초기화한 뒤 파렛트수를 고치세요.');
    }
    const pallet = Number(count);
    // 합친 묶음은 0을 허용하지 않는다 (0이 되면 묶음 종류 판정이 뒤집힌다)
    const minPallet = minPalletOf(target, batchGroupOf(db, target.id)?.rows);
    if (!Number.isInteger(pallet) || pallet < minPallet) {
        throw new Error(`총 파렛트수는 ${minPallet} 이상의 숫자로 입력하세요.`);
    }
    const before = target.pallet_count;
    if (before === pallet && mine.length === pallet) return target;

    if (pallet < mine.length) {
        // 끝에서부터 뺀다. 로케이션이 들어간 파렛트가 빠지면 사용자 확인을 거친다
        const removing = mine.slice(pallet);
        const located = removing.filter((x) => x.location);
        if (located.length && !opt.confirmRemove) {
            const err = new Error(`줄어드는 파렛트 ${removing.length}개 중 ${located.length}개에 `
                + '로케이션이 들어 있습니다.');
            err.needConfirm = true;
            err.removing = located.map((x) => `${x.barcode} (${formatLocation(x.location)})`);
            throw err;
        }
        const drop = new Set(removing.map((x) => x.id));
        db.pallets = db.pallets.filter((x) => !drop.has(x.id));
    } else if (pallet > mine.length) {
        // 끝에 이어 붙인다 (기존 바코드·로케이션은 그대로)
        const extra = makePallets({ ...target, pallet_count: pallet }).slice(mine.length);
        db.pallets.push(...extra);
    }

    addHistory(db, target.id, '파렛트수', before, pallet, user);
    target.pallet_count = pallet;
    target.inspected = 0;
    target.load_status = LOAD_STATUS.WAIT;
    // 0파렛트가 되면 적치할 것이 없으니 적치를 끝낸 것으로, 아니면 전량 입력 여부로 다시 판단한다
    if (pallet === 0) target.stow_done_at = target.stow_done_at ?? new Date().toISOString();
    else syncStowDone(db, target);
    await save(db);
    return target;
}

/**
 * 패킹리스트 내용 작성/수정 - **대표주문번호 묶음 전체에 같은 내용을 저장한다.**
 * 패킹리스트가 '있음' 인 주문만 대상이다.
 * 주문정보등록 목록의 패킹리스트 컬럼과 모바일 검수작업 탭이 **같은 값**을 다룬다.
 * 어느 쪽에서 쓰든 내용(`packing_note`)은 하나이고, 저장하면 양쪽에 그대로 반영된다.
 */
export async function setPackingNote(id, note, user) {
    const text = String(note ?? '').trim();
    const db = (await load());
    const { rows, head } = groupFor(db, id);
    if (rows.some((r) => loadDone(r))) {
        throw new Error('상차완료된 주문은 패킹리스트를 고칠 수 없습니다.');
    }
    const targets = rows.filter((r) => r.packing_yn === YN.YES);
    if (!targets.length) {
        throw new Error('패킹리스트가 있음인 주문만 작성할 수 있습니다.');
    }
    // 빈 내용은 저장하지 않는다. 검수완료(packing_at)된 주문의 내용이 지워지면
    // '패킹리스트 완료인데 내용 없음' 이라는 앞뒤 안 맞는 상태가 된다
    if (!text) throw new Error('패킹리스트 내용을 입력하세요.');
    const changed = targets.filter((r) => (r.packing_note ?? '') !== text);
    changed.forEach((r) => {
        addHistory(db, r.id, '패킹리스트 내용', r.packing_note, text, user);
        r.packing_note = text;
    });
    if (changed.length) await save(db);
    return targets.find((r) => r.id === id) ?? head;
}

/** 추가작업 완료 / 완료 취소 */
export async function setExtraWorkDone(id, done, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !o.inspect_done_at) {
        throw new Error('검수작업이 완료된 주문만 추가작업을 처리할 수 있습니다.');
    }
    if (!done && loadDone(o)) throw new Error('상차완료된 주문은 추가작업을 취소할 수 없습니다.');
    if (done) fillWorker(o, 'extra', user);
    setStepAt(db, o, 'extra_done_at', '추가작업', done, user);
    await save(db);
    return o;
}

/**
 * 출고주문처리 조정요청 탭에 표시할 요청 목록.
 * 두 갈래를 합친다.
 *   issue  - 이슈등록의 '작업요청' 유형 (주문번호로 연결)
 *   adjust - 주문 상세에서 등록되고 **접수 처리된** 조정요청
 * @returns {Array<{id, source, created_at, content, due_date, order}>}
 */
export async function listRequestTasks() {
    const db = (await load());
    const byNo = {};
    db.orders.forEach((o) => {
        (byNo[o.order_no] ??= []).push(o);
    });
    const rows = [];

    // 자동등록 건은 제외 - 원본 조정요청이 이미 아래 adjust 갈래로 표시된다
    db.issues
        .filter((i) => i.type === EXTRA_TASK_TYPE && i.order_no && !i.auto_created)
        .forEach((i) => {
            (byNo[i.order_no.trim()] ?? []).forEach((o) => rows.push({
                id: i.id,
                source: 'issue',
                created_at: i.created_at,
                category: '',
                content: i.content,
                due_date: i.due_date,
                order: o,
            }));
        });

    // 접수(확인) 처리된 조정요청만 현장 작업 대상이 된다
    db.restores.filter((r) => r.checked_at).forEach((r) => {
        const o = db.orders.find((x) => x.id === r.order_id);
        if (!o) return;
        rows.push({
            id: r.id,
            source: 'adjust',
            created_at: r.created_at,
            category: r.category,
            content: r.product_code || r.qty
                ? `${r.reason} (제품코드 ${r.product_code || '-'} / 수량 ${r.qty || '-'})`
                : r.reason,
            due_date: '',
            order: o,
        });
    });

    return rows.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

/** 추가작업 요청이 있는 주문번호 집합 (조정요청에서 자동등록된 건은 제외) */
function extraTaskNoSet(db) {
    return new Set(
        db.issues
            .filter((i) => i.type === EXTRA_TASK_TYPE && i.order_no && !i.auto_created)
            .map((i) => i.order_no.trim()),
    );
}

/** 주문번호별 추가작업 요청 여부 { 주문번호: true } */
export async function extraTaskMap() {
    const set = extraTaskNoSet((await load()));
    return Object.fromEntries([...set].map((no) => [no, true]));
}

/**
 * 주문 접수 - 물류 담당자가 상세 팝업에서 **작업지시를 작성해야** 접수된다.
 * 접수되면 확인 컬럼의 상태가 '접수' 로 바뀐다.
 * 🔑 **대표주문번호 묶음 전체에 적용된다.** 작업지시는 1회 작성해 묶인 주문 모두에 복사되고,
 * 이미 접수된 멤버가 섞여 있으면 미접수 멤버만 접수한다.
 * (대표주문번호가 없으면 주문 1건만 접수한다)
 */
export async function confirmOrderGroup(id, workNote, user) {
    const note = String(workNote ?? '').trim();
    if (!note) throw new Error('작업지시를 작성해야 접수할 수 있습니다.');
    const db = (await load());
    const { rows, head } = groupFor(db, id);
    const targets = rows.filter((r) => !r.confirmed_at);
    if (!targets.length) throw new Error('이미 접수된 주문입니다.');
    const at = new Date().toISOString();
    targets.forEach((r) => {
        r.confirmed_at = at;
        r.confirmed_by = user.id;
        r.confirmed_by_name = user.name;
        r.work_note = note;
        addHistory(db, r.id, '접수', '대기', `접수 · 작업지시: ${note}`, user);
    });
    await save(db);
    return head;
}

/**
 * 접수 취소 - 출고작업에 착수하기 전까지만 되돌릴 수 있다. 작업지시도 함께 초기화한다.
 * 접수와 마찬가지로 대표주문번호 묶음 전체에 적용된다.
 */
export async function revokeOrderConfirmGroup(id, user) {
    const db = (await load());
    const { rows, head } = groupFor(db, id);
    const targets = rows.filter((r) => r.confirmed_at);
    if (!targets.length) throw new Error('접수되지 않은 주문입니다.');
    const started = rows.filter((r) => r.ship_started_at || r.ship_done_at);
    if (started.length) {
        throw new Error(`출고작업에 착수한 주문은 접수를 취소할 수 없습니다 (${nosOf(started)}).`);
    }
    targets.forEach((r) => {
        r.confirmed_at = null;
        r.confirmed_by = null;
        r.confirmed_by_name = '';
        r.work_note = '';
        addHistory(db, r.id, '접수', '접수', '접수취소 (작업지시 초기화)', user);
    });
    await save(db);
    return head;
}

/**
 * 주문 취소 처리.
 * 취소하면 수정·조정요청을 할 수 없고 진행상태가 '취소' 로 바뀐다.
 */
export async function cancelOrder(id, user, reason = '') {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('이미 취소된 주문입니다.');
    o.canceled_at = new Date().toISOString();
    o.canceled_by = user.id;
    o.canceled_by_name = user.name;
    addHistory(db, id, '취소', '', '취소 처리', user, reason);
    await save(db);
    return o;
}

/**
 * 주문별 확인 현황 요약.
 * 확인 컬럼의 체크박스 상태와 이력 버튼 색상을 정하는 데 쓴다.
 * @returns {{[orderId:string]: {edits:number, editsLeft:number,
 *            restores:number, restoresLeft:number}}}
 */
export async function checkStats() {
    const db = (await load());
    const map = {};
    const get = (id) => (map[id] ??= { edits: 0, editsLeft: 0, restores: 0, restoresLeft: 0 });

    db.history.filter((h) => h.rev > 0).forEach((h) => {
        const m = get(h.order_id);
        m.edits += 1;
        if (!h.checked_at) m.editsLeft += 1;
    });
    db.restores.forEach((r) => {
        const m = get(r.order_id);
        m.restores += 1;
        if (!r.checked_at) m.restoresLeft += 1;
    });
    return map;
}

/**
 * 변동 이력 1건의 수정확인 상태를 토글한다.
 * 담당자가 변경 내용을 확인했는지 표시하는 용도이며, 잘못 누르면 다시 눌러 해제한다.
 */
export async function toggleHistoryCheck(historyId, user) {
    const db = (await load());
    const h = db.history.find((x) => x.id === historyId);
    if (!h) throw new Error('이력을 찾을 수 없습니다.');
    if (h.checked_at) {
        h.checked_at = null;
        h.checked_by = null;
        h.checked_by_name = '';
    } else {
        h.checked_at = new Date().toISOString();
        h.checked_by = user.id;
        h.checked_by_name = user.name;
    }
    await save(db);
    return h;
}

/** 주문별 변동사항 히스토리 */
export async function listHistory(orderId) {
    return (await load()).history
        .filter((h) => h.order_id === orderId)
        .sort((a, b) => (b.changed_at > a.changed_at ? 1 : -1));
}

/* --------------------------------- 조정요청 --------------------------------- */

/**
 * 조정요청 목록 조회
 * @param {string} [orderId] 주어지면 해당 주문의 요청만 반환
 */
export async function listRestores(orderId) {
    const rows = (await load()).restores;
    const filtered = orderId ? rows.filter((r) => r.order_id === orderId) : rows;
    return [...filtered].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

/**
 * 조정요청 1건의 확인 상태를 토글한다.
 * 변동 이력의 수정확인과 동작 방식이 같다.
 */
export async function toggleRestoreCheck(restoreId, user) {
    const db = (await load());
    const r = db.restores.find((x) => x.id === restoreId);
    if (!r) throw new Error('조정요청을 찾을 수 없습니다.');
    if (r.checked_at) {
        r.checked_at = null;
        r.checked_by = null;
        r.checked_by_name = '';
    } else {
        r.checked_at = new Date().toISOString();
        r.checked_by = user.id;
        r.checked_by_name = user.name;
    }
    await save(db);
    return r;
}

/**
 * 주문별 조정요청 현황 { 주문ID: { has, done } }.
 * done 은 등록된 조정요청이 모두 확인 처리되었는지를 뜻하며,
 * 주문처리현황의 '조정작업' 단계 완료 판단에 쓴다.
 */
export async function adjustMap() {
    const map = {};
    (await load()).restores.forEach((r) => {
        const m = (map[r.order_id] ??= { has: true, done: true });
        if (!r.checked_at) m.done = false;
    });
    return map;
}

/** 주문별 조정요청 건수를 { 주문ID: 건수 } 형태로 반환한다 */
export async function countRestores() {
    const map = {};
    (await load()).restores.forEach((r) => {
        map[r.order_id] = (map[r.order_id] ?? 0) + 1;
    });
    return map;
}

/**
 * 조정요청 등록.
 * type 이 'email' 이면 사유만, 'form' 이면 상세 항목까지 저장한다.
 * 주문 이력에도 함께 기록해 변동사항 히스토리에서 확인할 수 있게 한다.
 */
export async function createRestore(payload, user) {
    const db = (await load());
    const order = db.orders.find((o) => o.id === payload.order_id);
    if (!order) throw new Error('주문을 찾을 수 없습니다.');

    const row = {
        id: uid('r'),
        created_at: new Date().toISOString(),
        created_by: user.id,
        created_by_name: user.name,
        category: 'etc',
        product_code: '',
        qty: '',
        checked_at: null,      // 요청확인 일시 (null 이면 미확인)
        checked_by: null,
        checked_by_name: '',
        ...payload,
    };
    db.restores.push(row);

    const label = row.type === RESTORE_TYPE.EMAIL ? '이메일 발송' : '직접 작성';
    addHistory(db, order.id, '조정요청', '', `${label} · ${row.reason}`, user);

    // 조정요청은 이슈등록에도 작업요청 건으로 자동등록해 소통 창구를 하나로 모은다.
    // auto_created 건은 추가작업 요청 연동에서 제외된다 (조정요청 자체가 조정작업 단계를 만든다)
    const due = new Date();
    due.setDate(due.getDate() + 1);
    db.issues.push({
        id: uid('i'),
        type: EXTRA_TASK_TYPE,
        work_type: '출고',
        title: `${order.order_no} 조정요청 (${adjustCategory(row.category).label})`,
        order_no: order.order_no,
        content: [row.reason, row.product_code && `제품코드 ${row.product_code}`,
            row.qty && `수량 ${row.qty}`].filter(Boolean).join(' / '),
        due_date: toDateStr(due),
        status: ISSUE_STATE.WAIT,
        auto_created: true,
        created_by: user.id,
        created_at: new Date().toISOString(),
    });
    await save(db);
    return row;
}

/* -------------------------------- 상차 / 검수 -------------------------------- */

/**
 * 상차리스트 조회.
 * 상차 이외의 모든 작업(패킹리스트까지)이 완료된 주문만 대상으로 한다.
 *
 * 🔑 **묶음 전체가 준비돼야 실을 수 있다.** 상차 묶음은 한 거래처로 함께 실리는
 * 한 덩어리라, 한 멤버라도 준비가 안 됐으면 그 묶음은 오늘 실을 수 없다.
 * 준비된 멤버만 추려 묶으면 목록의 진행(`3/3`)과 실제 스캔 대상(`/8`)이 어긋나고,
 * `completeLoading` 이 묶음 전체를 다시 확인하므로 완료도 되지 않는다.
 * 그래서 목록·상차검수·상차완료가 **모두 같은 모집단(`loadGroups`)** 을 쓴다.
 *
 * ⚠️ 준비되지 않은 묶음을 **목록에서 지우지 않는다.** 추가주문 차수가 늦게 들어오면
 * 이미 준비를 마친 1차수까지 사유 없이 사라져 현장이 원인을 볼 수 없었다.
 * `blocked` `block_reason` 을 붙여 함께 돌려주고, 화면이 회색으로 구분해 보여준다.
 */
export async function listLoading(shipDate) {
    const db = (await load());
    const optOf = stepOptOf(db);
    const pool = db.orders.filter((o) => o.ship_req_date === shipDate && !o.canceled_at);

    // 대표주문번호·추가주문 차수는 한 거래처로 함께 배송되므로 묶어서 대표 1건만 보여준다
    return loadGroups(pool)
        .map((g) => {
            const head = g.head;
            const pallets = palletsOf(db, g.rows);
            const reason = notReadyReason(g.rows, optOf);
            return {
                ...head,
                // 막힌 묶음 - 상차검수·상차완료를 막고 사유를 보여준다 (합계에서도 뺀다)
                blocked: Boolean(reason),
                block_reason: reason,
                // 목록·라벨에 보여줄 번호 (대표주문번호가 있으면 그것을 쓴다)
                group_no: head.rep_no || head.order_no,
                group_nos: g.rows.map((r) => r.order_no),
                group_count: g.rows.length,
                group_pallets: pallets.length,
                // 박스수는 묶음 전체의 합계다 (대표에만 총량을 적는 묶음도 그대로 더해진다)
                group_boxes: g.rows.reduce((a, r) => a + Number(r.box_count ?? 0), 0),
                group_inspected: pallets.filter((p) => p.scanned_at).length,
            };
        })
        .sort((a, b) => (a.group_no > b.group_no ? 1 : -1));
}

/**
 * 넘긴 주문들의 파렛트를 주문 순으로 모은다.
 * 라벨 번호는 **주문 안에서** 매기므로, 묶음에서 일부 주문만 넘겨도 번호가 흔들리지 않는다.
 */
function palletsOf(db, rows) {
    return rows.flatMap((r) => db.pallets
        .filter((p) => p.order_id === r.id)
        .map((p, i) => ({
            ...p,
            seq: r.seq,
            // 묶음 화면에서 어느 주문의 파렛트인지 보여주기 위해 함께 담는다
            order_no: r.order_no,
            label: `${r.order_no}-${String(i + 1).padStart(2, '0')}`,
        })));
}

/**
 * 상차 묶음 단위 (`groupKeyOf` 로 묶는다 - 대표주문번호 · 추가주문 차수).
 * 대표주문번호로 묶인 주문과 추가주문 차수는 한 거래처로 함께 배송되므로
 * **상차만은** 묶어서 본다 (적치 파렛트 합산 · 상차검수 · 상차완료).
 *
 * @returns {{head:object, rows:object[], pallets:object[],
 *   blocked:boolean, block_reason:string}}
 *   head    - 묶음 대표 (`compareHead` 규칙 - 차수 묶음만 있으면 1차수)
 *   rows    - 취소되지 않은 묶음 전체 (대표부터 등록순)
 *   pallets - 묶음 전체의 파렛트 (주문 순 → 파렛트 번호 순, seq/label 이 붙는다)
 *   blocked - 상차 이외의 단계가 남은 멤버가 있어 오늘 실을 수 없는 묶음
 *   block_reason - 그 사유 (`completeLoading` 의 거부 문구와 같은 계산)
 */
function groupOf(db, orderId) {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return null;
    const key = groupKeyOf(o);
    const rows = db.orders
        .filter((x) => groupKeyOf(x) === key && !x.canceled_at)
        .sort(compareHead);
    const reason = notReadyReason(rows, stepOptOf(db));
    return {
        head: rows[0] ?? o,
        rows,
        pallets: palletsOf(db, rows),
        blocked: Boolean(reason),
        block_reason: reason,
    };
}

/** 상차 단위 조회 (화면용) */
export async function getLoadGroup(orderId) {
    return groupOf((await load()), orderId);
}

/**
 * 일괄 처리 단위 조회 (화면용) - 대표주문번호가 있을 때만 묶인다.
 * @param {boolean} canceled 취소된 멤버까지 담을지 (상세 팝업의 묶인 주문번호 표에서 쓴다)
 */
export async function getBatchGroup(orderId, canceled = false) {
    return batchGroupOf((await load()), orderId, canceled);
}

export async function listPallets(orderId) {
    return (await load()).pallets.filter((p) => p.order_id === orderId);
}

/**
 * 출고적치 - 파렛트 1개의 로케이션을 기록한다.
 * 검수작업이 끝난 주문만 적치할 수 있고, 전량 입력되면 `stow_done_at` 이 자동으로 채워진다.
 */
export async function setPalletLocation(palletId, location) {
    const db = (await load());
    const p = db.pallets.find((x) => x.id === palletId);
    if (!p) throw new Error('파렛트를 찾을 수 없습니다.');
    const o = db.orders.find((x) => x.id === p.order_id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (!o.inspect_done_at) throw new Error('검수작업이 완료된 주문만 적치할 수 있습니다.');

    const value = formatLocation(location);
    if (!isValidLocation(value)) {
        throw new Error(`로케이션은 ${LOCATION_FORMAT} 형식으로 입력하세요.`);
    }
    p.location = value;
    syncStowDone(db, o);
    await save(db);
    return o;
}

/**
 * 평치 일괄이동 - 그 주문의 **로케이션이 비어 있는 파렛트를 모두** 평치(FLOOR_LOCATION)로 기록한다.
 * 이미 랙 로케이션이 들어간 파렛트는 건드리지 않는다 (입력한 값을 지우지 않게).
 * 한 번에 같은 값을 넣으므로 이력에 건수를 남긴다.
 * @returns {{order:object, count:number}} 주문과 평치로 옮긴 파렛트 수
 */
export async function setFloorAll(orderId, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (!o.inspect_done_at) throw new Error('검수작업이 완료된 주문만 적치할 수 있습니다.');
    if (loadDone(o)) throw new Error('상차완료된 주문은 적치를 바꿀 수 없습니다.');

    const targets = db.pallets.filter((p) => p.order_id === o.id && !p.location);
    if (!targets.length) return { order: o, count: 0 };
    targets.forEach((p) => { p.location = FLOOR_LOCATION; });
    syncStowDone(db, o);
    addHistory(db, o.id, '출고적치', '', FLOOR_LOCATION, user, `평치 일괄이동 ${targets.length}건`);
    await save(db);
    return { order: o, count: targets.length };
}

/** 로케이션 지우기 (잘못 입력한 경우) */
export async function clearPalletLocation(palletId) {
    const db = (await load());
    const p = db.pallets.find((x) => x.id === palletId);
    if (!p) throw new Error('파렛트를 찾을 수 없습니다.');
    const o = db.orders.find((x) => x.id === p.order_id);
    if (loadDone(o)) throw new Error('상차완료된 주문은 적치를 되돌릴 수 없습니다.');
    p.location = '';
    if (o) syncStowDone(db, o);
    await save(db);
    return o;
}

/**
 * 출고적치 취소 - 그 주문의 로케이션을 모두 지우고 적치완료를 되돌린다.
 * 검수작업을 취소하려면 이 단계를 먼저 거쳐야 한다.
 */
export async function cancelStow(orderId, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (loadDone(o)) throw new Error('상차완료된 주문은 적치를 되돌릴 수 없습니다.');

    const mine = db.pallets.filter((p) => p.order_id === o.id);
    const had = mine.filter((p) => p.location).length;
    if (!had && !o.stow_done_at) throw new Error('아직 적치된 파렛트가 없습니다.');

    mine.forEach((p) => { p.location = ''; });
    o.stow_done_at = null;
    addHistory(db, o.id, '출고적치', '완료', '취소', user, `로케이션 ${had}건 삭제`);
    await save(db);
    return o;
}

/** 파렛트 전량에 로케이션이 있으면 출고적치 완료로 본다 */
function syncStowDone(db, o) {
    const mine = db.pallets.filter((p) => p.order_id === o.id);
    const all = mine.length > 0 && mine.every((p) => p.location);
    // 🔑 완료는 화면의 `적치완료` 버튼으로만 찍는다 (자동으로 올리지 않는다).
    // 다만 로케이션이 하나라도 비면 완료를 유지할 수 없으므로 되돌린다
    if (!all && o.stow_done_at) o.stow_done_at = null;
}

/**
 * 출고적치 완료처리.
 * 파렛트 **전량에 로케이션이 들어간 뒤** 담당자가 눌러 확정한다.
 */
export async function completeStow(orderId, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (!o.inspect_done_at) throw new Error('검수작업이 완료된 주문만 적치할 수 있습니다.');
    if (o.stow_done_at) throw new Error('이미 적치완료된 주문입니다.');

    const mine = db.pallets.filter((p) => p.order_id === o.id);
    const left = mine.filter((p) => !p.location).length;
    if (!mine.length) throw new Error('적치할 파렛트가 없습니다.');
    if (left) throw new Error(`로케이션이 비어 있는 파렛트가 ${left}건 있습니다.`);

    o.stow_done_at = new Date().toISOString();
    addHistory(db, o.id, '출고적치', '', '완료', user);
    await save(db);
    return o;
}

/**
 * 상차 준비 - 적치된 파렛트를 하나씩 내린다 (상차리스트의 로케이션 팝업).
 * 상차완료된 주문은 더 이상 바꾸지 않는다.
 */
export async function setPalletPicked(palletId, done) {
    const db = (await load());
    const p = db.pallets.find((x) => x.id === palletId);
    if (!p) throw new Error('파렛트를 찾을 수 없습니다.');
    const o = db.orders.find((x) => x.id === p.order_id);
    if (loadDone(o)) throw new Error('상차완료된 주문은 변경할 수 없습니다.');
    if (done && !p.location) throw new Error('적치 로케이션이 없는 파렛트입니다.');
    p.picked_at = done ? new Date().toISOString() : null;
    await save(db);
    return p;
}

/**
 * 상차검수 통과 판정 🔑 (`scanPallet` · `cancelLoading` 이 함께 쓴다)
 *
 * 파렛트를 가진 주문은 **전량 스캔**돼야 검수완료다.
 * 0파렛트 멤버(혼적 추가건 · 등록 시 묶음의 멤버)는 스캔할 라벨이 없으므로
 * **검수작업(`inspect_done_at`)이 끝났을 때만** 검수완료로 본다.
 * ⚠️ `inspected >= pallet_count` 만 보면 `0 >= 0` 이 참이라, 검수작업도 끝나지 않은
 * 0파렛트 멤버가 **남의 라벨 스캔만으로** 상차검수를 통과해 상차완료·마감까지 올라간다.
 */
function scanDone(o) {
    return Number(o.pallet_count ?? 0) > 0
        ? Number(o.inspected ?? 0) >= Number(o.pallet_count)
        : Boolean(o.inspect_done_at);
}

/** 아직 스캔되지 않은 파렛트를 주문별로 요약한다 (`PO-2 2장, PO-3 1장`) */
function leftByOrder(rows, pallets) {
    return rows
        .map((r) => {
            const left = pallets.filter((p) => p.order_id === r.id && !p.scanned_at).length;
            return left ? `${r.order_no} ${left}장` : '';
        })
        .filter(Boolean)
        .join(', ');
}

/**
 * 파렛트 바코드 스캔 처리 (상차 검수) 🔑
 *
 * 상차라벨의 바코드는 주문번호다. 파렛트마다 같은 라벨이 붙으므로 주문번호를 스캔할
 * 때마다 아직 검수되지 않은 파렛트를 하나씩 채운다. 채우는 **범위**는 스캔한 코드가
 * 무엇이냐로 갈린다.
 *
 * | 스캔한 코드 | 채우는 범위 |
 * |---|---|
 * | 멤버의 `order_no` (그 주문이 자기 파렛트를 가짐) | **그 주문의** 미검수 파렛트 1개 |
 * | 대표주문번호 `rep_no` · 파렛트가 없는 멤버의 번호 | 묶음 전체의 미검수 파렛트 1개 |
 * | 파렛트 개별 바코드 `{주문번호}-P01` | 그 파렛트 |
 *
 * 🔑 검수 후 합친 묶음은 **주문마다 자기 라벨이 이미 출력돼 있다.** 묶음 전체에서
 * 아무거나 채우면 A 라벨만 계속 읽어도 B 파렛트가 채워져 실물과 어긋난다.
 * 등록 시 묶은 묶음(총량이 대표에만 있고 멤버는 0파렛트)은 종전 동작 그대로다.
 * @returns {{ok:boolean, msg:string, order?:object}}
 */
export async function scanPallet(orderId, barcode, user) {
    const db = (await load());
    const code = String(barcode).trim().toUpperCase();
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return { ok: false, msg: '주문을 찾을 수 없습니다.' };

    // 추가주문까지 한 번에 검수한다 (같은 주문번호의 모든 차수)
    const group = groupOf(db, orderId);
    const ids = new Set(group.rows.map((r) => r.id));
    const mine = db.pallets.filter((p) => ids.has(p.order_id));
    if (!mine.length) {
        return {
            ok: false,
            msg: '검수할 파렛트가 없습니다. 출고주문처리 검수작업에서 파렛트수를 입력하세요.',
        };
    }

    const up = (v) => String(v).trim().toUpperCase();
    // 스캔한 코드가 어느 멤버의 주문번호인지 (대표주문번호와 같은 번호면 그 멤버가 잡힌다)
    const member = group.rows.find((r) => up(r.order_no) === code);
    const ours = member ? mine.filter((p) => p.order_id === member.id) : [];
    // 파렛트가 없는 멤버(등록 시 묶음의 혼적 건)와 대표주문번호는 묶음 전체에서 채운다
    const scope = ours.length ? ours : mine;
    // 🔑 주문별 안내는 **다른 주문의 파렛트도 있을 때만** 붙인다.
    // 등록 시 묶은 묶음은 대표가 파렛트를 전부 갖고 있어(`ours.length === mine.length`)
    // 대표번호를 스캔해도 묶음 전체를 읽는 것과 같다 - 종전 문구를 그대로 쓴다
    const perOrder = ours.length > 0 && ours.length !== mine.length;
    const repNos = new Set(group.rows.map((r) => r.rep_no).filter(Boolean).map(up));
    const isOrderCode = Boolean(member) || repNos.has(code);
    const target = isOrderCode
        ? scope.find((p) => !p.scanned_at)
        : mine.find((p) => p.barcode.toUpperCase() === code);

    if (!target) {
        if (!isOrderCode) return { ok: false, msg: '해당 주문의 바코드가 아닙니다.' };
        const left = leftByOrder(group.rows, mine);
        return {
            ok: false,
            msg: perOrder
                ? `${member.order_no} 주문은 전량 검수되었습니다.`
                    + ` (${ours.length}/${ours.length})`
                    + (left ? ` 남은 주문: ${left}` : '')
                : `이미 전량 검수되었습니다. (${mine.length}/${mine.length})`,
        };
    }
    if (target.scanned_at) return { ok: false, msg: '이미 검수된 파렛트입니다.' };

    target.scanned_at = new Date().toISOString();
    // 차수별 검수 수를 각각 갱신하고, 그 차수가 다 차면 검수 상태로 올린다
    group.rows.forEach((r) => {
        r.inspected = db.pallets.filter((p) => p.order_id === r.id && p.scanned_at).length;
        if (scanDone(r) && r.load_status === LOAD_STATUS.WAIT) {
            r.load_status = LOAD_STATUS.INSPECTED;
            addHistory(db, r.id, '검수', '대기', '검수완료', user);
        }
    });
    const done = mine.filter((p) => p.scanned_at).length;
    // 묶음 전체 진행과 그 주문의 진행을 함께 알려 준다 (무엇을 더 읽어야 하는지 보이게)
    const my = perOrder
        ? ` · ${member.order_no} ${ours.filter((p) => p.scanned_at).length}/${ours.length}`
        : '';
    await save(db);
    return { ok: true, msg: `검수 완료 (${done}/${mine.length})${my}`, order: o };
}

/**
 * 상차검수 취소 (전체 초기화).
 * ⚠️ **상차완료된 묶음은 되돌릴 수 없다.** 상차완료를 먼저 취소해야 한다.
 * 이걸 막지 않으면 `loaded_at` 은 남은 채 상차 상태만 `대기` 로 돌아가
 * 화면에는 상차 전으로 보이는데 다른 처리는 `상차완료된 주문` 이라며 거부되는
 * 앞뒤 안 맞는 상태가 된다 (적치취소·검수취소와 같은 순서 규칙이다).
 */
export async function resetInspection(orderId, user) {
    const db = (await load());
    const group = groupOf(db, orderId);
    if (!group) throw new Error('주문을 찾을 수 없습니다.');
    if (group.rows.some((r) => loadDone(r))) {
        throw new Error('상차완료된 주문입니다. 상차리스트에서 상차완료를 먼저 취소하세요.');
    }
    const ids = new Set(group.rows.map((r) => r.id));
    db.pallets.filter((p) => ids.has(p.order_id)).forEach((p) => { p.scanned_at = null; });
    group.rows.forEach((r) => {
        // 이력의 이전 값은 실제 상태를 적는다 (예전에는 '검수완료' 로 고정돼 있었다)
        addHistory(db, r.id, '검수', r.load_status, LOAD_STATUS.WAIT, user);
        r.inspected = 0;
        r.load_status = LOAD_STATUS.WAIT;
    });
    await save(db);
    return group.head;
}

/**
 * 상차완료 처리 🔑
 * `loaded_at` 은 **상차 묶음 전체**에 찍히므로, 찍기 전에 멤버마다
 * ① 상차검수 통과(`load_status`) ② **상차 이외의 모든 단계 완료**(`readyToLoad`)를
 * 다시 확인한다. 판정은 상차리스트와 같은 함수를 쓴다 (`steps.js` 의 `readyToLoad`).
 *
 * ⚠️ 상차검수만 보면 검수·적치를 건너뛴 주문이 묶음에 딸려 상차완료·마감까지 올라간다.
 * 목록에서 보이지 않던 멤버도 `groupOf` 로 다시 펼쳐지므로 여기서 한 번 더 막는다.
 */
export async function completeLoading(orderId, user) {
    const db = (await load());
    const group = groupOf(db, orderId);
    if (!group) throw new Error('주문을 찾을 수 없습니다.');
    // 추가주문까지 함께 실리므로 차수 전체가 검수되어야 상차완료할 수 있다
    if (group.rows.some((r) => r.load_status !== LOAD_STATUS.INSPECTED)) {
        throw new Error('검수가 완료된 건만 상차완료 처리할 수 있습니다.');
    }
    const detail = notReadyReason(group.rows, stepOptOf(db));
    if (detail) {
        throw new Error(`상차 이외의 단계가 끝나지 않은 주문이 있습니다. (${detail})`);
    }
    const at = new Date().toISOString();
    group.rows.forEach((r) => {
        r.load_status = LOAD_STATUS.DONE;
        r.loaded_at = at;
        addHistory(db, r.id, '상차작업', '', '완료', user);
    });
    await save(db);
    return group.head;
}

/**
 * 상차완료 취소.
 * 잘못 찍은 상차를 되돌린다. 묶음 전체(모든 차수)에 적용되며 검수 상태로 돌아간다.
 * ⚠️ **완료처리(마감)된 주문은 되돌릴 수 없다.** 완료처리를 먼저 취소해야 한다.
 */
export async function cancelLoading(orderId, user) {
    const db = (await load());
    const group = groupOf(db, orderId);
    if (!group) throw new Error('주문을 찾을 수 없습니다.');
    if (group.rows.some((r) => r.closed_at)) {
        throw new Error('완료처리된 주문입니다. 주문처리현황에서 완료처리를 먼저 취소하세요.');
    }
    if (!group.rows.some((r) => r.loaded_at)) {
        throw new Error('상차완료된 주문이 아닙니다.');
    }
    // 묶음에서 실제로 스캔된 파렛트가 있는지 (0파렛트 멤버의 상태 판단에 쓴다)
    const scanned = group.pallets.filter((p) => p.scanned_at).length;
    group.rows.forEach((r) => {
        r.loaded_at = null;
        // 상차만 되돌린다. 상차검수는 실제 스캔한 수를 보고 상태를 정한다
        // (전량 검수돼 있으면 '검수', 아니면 '대기' — 값을 고정하면 어긋난 건이 남는다)
        // 🔑 0파렛트 멤버(혼적·대표주문번호 묶음)는 스캔할 파렛트가 없으므로
        // `scanPallet` 과 **같은 판정 함수**(`scanDone`)를 쓴다.
        // 그러지 않으면 '대기' 로 남아 재상차가 막힌다
        r.load_status = scanned > 0 && scanDone(r) ? LOAD_STATUS.INSPECTED : LOAD_STATUS.WAIT;
        addHistory(db, r.id, '상차작업', '완료', '취소', user);
    });
    await save(db);
    return group.head;
}

/**
 * 출고 완료처리 / 완료처리 취소 - 대표주문번호 묶음 전체에 적용된다.
 * 상차작업까지 끝난 주문을 용마담당자가 최종 마감하는 단계다.
 * 완료처리된 주문은 주문처리현황의 `현재진행` 탭에서 빠지고 `출고완료` 탭으로 간다.
 */
export async function closeOrder(id, done, user) {
    const db = (await load());
    const { rows, head } = groupFor(db, id);
    const left = rows.filter((r) => !loadDone(r));
    if (done && left.length) {
        throw new Error(`상차작업까지 완료된 주문만 완료처리할 수 있습니다 (${nosOf(left)}).`);
    }
    const at = done ? new Date().toISOString() : null;
    rows.forEach((r) => {
        r.closed_at = at;
        addHistory(db, r.id, '출고완료', done ? '진행' : '완료', done ? '완료' : '진행', user);
    });
    await save(db);
    return head;
}

/** 전체 조정요청 (상세검색에서 본문을 훑을 때 쓴다) */
export async function listAllRestores() {
    return [...(await load()).restores];
}

/* ----------------------------------- 이슈 ----------------------------------- */

export async function listIssues(f = {}) {
    const db = (await load());
    let rows = [...db.issues];
    if (f.createdBy) rows = rows.filter((i) => i.created_by === f.createdBy);
    if (f.status) rows = rows.filter((i) => i.status === f.status);
    if (f.keyword) {
        const k = f.keyword.trim().toLowerCase();
        rows = rows.filter((i) => `${i.title} ${i.order_no}`.toLowerCase().includes(k));
    }
    rows.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    // 등록자 이름을 화면 표시용으로 붙인다 (저장 컬럼이 아니라 서버로는 나가지 않는다)
    const nameById = Object.fromEntries(db.users.map((u) => [u.id, u.name]));
    return rows.map((i) => ({ ...i, creator_name: nameById[i.created_by] ?? '' }));
}

export async function createIssue(payload, user) {
    const db = (await load());
    const row = {
        id: uid('i'),
        created_at: new Date().toISOString(),
        status: ISSUE_STATE.WAIT,
        created_by: user.id,
        ...payload,
    };
    db.issues.push(row);
    await save(db);
    return row;
}

export async function updateIssue(id, patch) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    Object.assign(i, patch);
    await save(db);
    return i;
}

/** 이슈 확인담당자 후보 - 소속이 용마로지스이고 권한이 용마담당자인 활성 사용자 */
export async function listIssueAssignees() {
    return (await load()).users.filter((u) => u.company === COMPANY.LOGISTICS
        && u.role === ROLE.YONGMA && u.active !== false);
}

/** 이슈접수 - 확인담당자를 지정하면 상태가 접수대기 → 접수완료 로 바뀐다 */
export async function acceptIssue(id, assigneeId, user) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    if (i.status !== ISSUE_STATE.WAIT) {
        throw new Error(`${ISSUE_STATE.WAIT} 상태의 이슈만 접수할 수 있습니다.`);
    }
    if (!canAcceptIssue(user, i)) throw new Error('이슈를 접수할 권한이 없습니다.');
    const u = db.users.find((x) => x.id === assigneeId);
    if (!u) throw new Error('확인담당자를 찾을 수 없습니다.');
    Object.assign(i, {
        status: ISSUE_STATE.OPEN,
        assignee_id: u.id,
        assignee_name: u.name,
    });
    await save(db);
    return i;
}

/* 이슈 단계별 처리 권한 - 팝업의 버튼 노출과 실제 처리에 같은 판정을 쓴다 */

/**
 * 이슈접수 가능 여부 - 접수대기 상태에서 **이슈 상태를 바꿀 수 있는 역할**만 접수한다
 * (출고·검수를 처리하면서 이슈도 등록하는 역할 = 관리자·용마담당자).
 * 다른 단계와 달리 담당자 지정이 아니라 역할로 판정한다.
 */
export function canAcceptIssue(user, issue) {
    if (!user || issue?.status !== ISSUE_STATE.WAIT) return false;
    const perm = PERMISSION[user.role] ?? {};
    return Boolean((perm.updateStatus && perm.createIssue) || perm.manageUsers);
}

/** 담당자확인 가능 여부 - 접수완료 상태에서 선정된 담당자 본인 또는 관리자 */
export function canConfirmAssignee(user, issue) {
    return issue.status === ISSUE_STATE.OPEN && !!user
        && (user.id === issue.assignee_id || !!PERMISSION[user.role]?.manageUsers);
}

/** 종결요청 가능 여부 - 접수완료·확인중 상태에서 선정된 담당자 또는 관리자 */
export function canRequestClose(user, issue) {
    return [ISSUE_STATE.OPEN, ISSUE_STATE.DOING].includes(issue.status) && !!user
        && (user.id === issue.assignee_id || !!PERMISSION[user.role]?.manageUsers);
}

/** 이슈취소 가능 여부 - 종결요청 전(접수대기~확인중)에 등록자 본인 또는 관리자 */
export function canCancelIssue(user, issue) {
    return [ISSUE_STATE.WAIT, ISSUE_STATE.OPEN, ISSUE_STATE.DOING].includes(issue.status)
        && !!user && (user.id === issue.created_by || !!PERMISSION[user.role]?.manageUsers);
}

/** 종결승인 가능 여부 - 종결요청 상태에서 등록자, 고객사 소속 화주관리자, 관리자 */
export function canApproveClose(user, issue) {
    return issue.status === ISSUE_STATE.CLOSE_REQ && !!user
        && (user.id === issue.created_by
            || !!PERMISSION[user.role]?.manageUsers
            || (user.role === ROLE.SHIPPER_ADMIN && user.company === COMPANY.CUSTOMER));
}

/** 담당자확인 - 선정된 담당자(또는 관리자)가 확인하면 접수완료 → 확인중 */
export async function confirmIssueAssignee(id, user) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    if (!canConfirmAssignee(user, i)) {
        throw new Error('선정된 확인담당자 또는 관리자만 담당자확인을 할 수 있습니다.');
    }
    i.status = ISSUE_STATE.DOING;
    await save(db);
    return i;
}

/** 종결요청 - 담당자·관리자가 처리를 마치고 등록자 쪽에 승인을 요청한다 */
export async function requestIssueClose(id, user) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    if (!canRequestClose(user, i)) {
        throw new Error('선정된 담당자 또는 관리자만 종결요청을 할 수 있습니다.');
    }
    i.status = ISSUE_STATE.CLOSE_REQ;
    await save(db);
    return i;
}

/** 종결승인 - 등록자(또는 고객사 화주관리자)가 승인하면 종결완료 + 종결일자 기록 */
export async function approveIssueClose(id, user) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    if (!canApproveClose(user, i)) {
        throw new Error('등록자 또는 고객사 화주관리자만 종결승인을 할 수 있습니다.');
    }
    i.status = ISSUE_STATE.CLOSED;
    i.closed_at = new Date().toISOString();
    await save(db);
    return i;
}

/** 이슈취소 - 등록자·관리자가 종결요청 전에 취소하면 확인취소 + 취소일자 기록 */
export async function cancelIssue(id, user) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    if (!canCancelIssue(user, i)) {
        throw new Error('등록자 또는 관리자만 종결요청 전까지 취소할 수 있습니다.');
    }
    i.status = ISSUE_STATE.CANCELED;
    i.canceled_at = new Date().toISOString();
    await save(db);
    return i;
}

/* --------------------------------- 이슈 댓글 --------------------------------- */

/** 이슈의 댓글 목록 - 등록순. 대댓글 트리는 화면이 parent_id 로 구성한다 */
export async function listIssueComments(issueId) {
    return (await load()).comments
        .filter((c) => c.issue_id === issueId)
        .sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
}

/** 댓글 등록 - parentId 가 있으면 그 댓글의 대댓글이 된다 */
export async function addIssueComment(issueId, parentId, content, user) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('댓글 내용을 입력하세요.');
    const db = (await load());
    if (!db.issues.some((i) => i.id === issueId)) throw new Error('이슈를 찾을 수 없습니다.');
    const row = {
        id: uid('c'),
        issue_id: issueId,
        parent_id: parentId || null,
        content: text,
        created_by: user.id,
        created_by_name: user.name,
        created_at: new Date().toISOString(),
        updated_at: null,
        deleted_at: null,
    };
    db.comments.push(row);
    await save(db);
    return row;
}

/** 댓글 수정 - 작성자 본인만. 수정 시각을 남겨 '수정됨' 을 표시한다 */
export async function updateIssueComment(id, content, user) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('댓글 내용을 입력하세요.');
    const db = (await load());
    const c = db.comments.find((x) => x.id === id);
    if (!c) throw new Error('댓글을 찾을 수 없습니다.');
    if (c.created_by !== user.id) throw new Error('작성자 본인만 수정할 수 있습니다.');
    if (c.deleted_at) throw new Error('삭제된 댓글은 수정할 수 없습니다.');
    c.content = text;
    c.updated_at = new Date().toISOString();
    await save(db);
    return c;
}

/**
 * 댓글 삭제 - 작성자 본인만.
 * 대댓글이 달린 댓글은 스레드를 지키기 위해 내용만 비운다(soft delete).
 */
export async function deleteIssueComment(id, user) {
    const db = (await load());
    const c = db.comments.find((x) => x.id === id);
    if (!c) throw new Error('댓글을 찾을 수 없습니다.');
    if (c.created_by !== user.id) throw new Error('작성자 본인만 삭제할 수 있습니다.');
    const hasReplies = db.comments.some((x) => x.parent_id === id);
    if (hasReplies) {
        c.content = '';
        c.deleted_at = new Date().toISOString();
    } else {
        db.comments = db.comments.filter((x) => x.id !== id);
    }
    await save(db);
}

/* ---------------------------------- 공지사항 ---------------------------------- */

/** 공지 등록·수정·삭제 권한 (조회와 댓글 등록은 로그인 사용자 모두 가능하다) */
export function canManageNotice(user) {
    return !!PERMISSION[user?.role]?.manageNotice;
}

/** 공지 댓글을 수정·삭제할 수 있는지 - 작성자 본인 또는 관리자 */
export function canEditNoticeComment(user, comment) {
    if (!user || !comment) return false;
    return comment.created_by === user.id || !!PERMISSION[user.role]?.manageUsers;
}

/**
 * 공지 목록.
 * 중요공지를 위로 고정하고, 그 안에서는 최신순으로 정렬한다.
 * 삭제된 공지(deleted_at)는 목록에서 빠진다.
 */
export async function listNotices(f = {}) {
    const db = (await load());
    let rows = db.notices.filter((n) => !n.deleted_at);
    if (f.keyword) {
        const k = f.keyword.trim().toLowerCase();
        rows = rows.filter((n) => `${n.title} ${n.content}`.toLowerCase().includes(k));
    }
    rows.sort((a, b) => {
        if (!!a.important !== !!b.important) return a.important ? -1 : 1;
        return b.created_at > a.created_at ? 1 : -1;
    });
    // 댓글 수는 화면 표시용이라 저장 컬럼이 아니다 (서버로 나가지 않는다)
    return rows.map((n) => ({
        ...n,
        comment_count: db.noticeComments
            .filter((c) => c.notice_id === n.id && !c.deleted_at).length,
    }));
}

/** 공지 1건 조회 (삭제된 건은 없는 것으로 본다) */
export async function getNotice(id) {
    const n = (await load()).notices.find((x) => x.id === id);
    return n && !n.deleted_at ? n : null;
}

/** 공지 등록 - 관리자·용마담당자만 */
export async function createNotice(payload, user) {
    if (!canManageNotice(user)) throw new Error('공지사항을 등록할 권한이 없습니다.');
    const title = String(payload.title ?? '').trim();
    const content = String(payload.content ?? '').trim();
    if (!title) throw new Error('제목을 입력하세요.');
    if (!content) throw new Error('내용을 입력하세요.');

    const db = (await load());
    const row = {
        id: uid('n'),
        title,
        content,
        important: !!payload.important,
        created_by: user.id,
        created_by_name: user.name,
        created_at: new Date().toISOString(),
        updated_at: null,
        deleted_at: null,
    };
    db.notices.push(row);
    await save(db);
    return row;
}

/** 공지 수정 - 관리자·용마담당자만. 수정 시각을 남긴다 */
export async function updateNotice(id, patch, user) {
    if (!canManageNotice(user)) throw new Error('공지사항을 수정할 권한이 없습니다.');
    const title = String(patch.title ?? '').trim();
    const content = String(patch.content ?? '').trim();
    if (!title) throw new Error('제목을 입력하세요.');
    if (!content) throw new Error('내용을 입력하세요.');

    const db = (await load());
    const n = db.notices.find((x) => x.id === id && !x.deleted_at);
    if (!n) throw new Error('공지사항을 찾을 수 없습니다.');
    n.title = title;
    n.content = content;
    n.important = !!patch.important;
    n.updated_at = new Date().toISOString();
    await save(db);
    return n;
}

/**
 * 공지 삭제 - 관리자·용마담당자만.
 * 댓글 스레드를 남겨 두려고 행을 지우지 않고 deleted_at 만 찍는다(soft delete).
 */
export async function deleteNotice(id, user) {
    if (!canManageNotice(user)) throw new Error('공지사항을 삭제할 권한이 없습니다.');
    const db = (await load());
    const n = db.notices.find((x) => x.id === id && !x.deleted_at);
    if (!n) throw new Error('공지사항을 찾을 수 없습니다.');
    n.deleted_at = new Date().toISOString();
    await save(db);
}

/** 공지 댓글 목록 - 등록순. 대댓글 트리는 화면이 parent_id 로 구성한다 */
export async function listNoticeComments(noticeId) {
    return (await load()).noticeComments
        .filter((c) => c.notice_id === noticeId)
        .sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
}

/** 공지 댓글 등록 - 로그인 사용자 모두. parentId 가 있으면 대댓글이 된다 */
export async function addNoticeComment(noticeId, parentId, content, user) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('댓글 내용을 입력하세요.');
    const db = (await load());
    if (!db.notices.some((n) => n.id === noticeId && !n.deleted_at)) {
        throw new Error('공지사항을 찾을 수 없습니다.');
    }
    const row = {
        id: uid('nc'),
        notice_id: noticeId,
        parent_id: parentId || null,
        content: text,
        created_by: user.id,
        created_by_name: user.name,
        created_at: new Date().toISOString(),
        updated_at: null,
        deleted_at: null,
    };
    db.noticeComments.push(row);
    await save(db);
    return row;
}

/** 공지 댓글 수정 - 작성자 본인 또는 관리자. 수정 시각을 남겨 '수정됨' 을 표시한다 */
export async function updateNoticeComment(id, content, user) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('댓글 내용을 입력하세요.');
    const db = (await load());
    const c = db.noticeComments.find((x) => x.id === id);
    if (!c) throw new Error('댓글을 찾을 수 없습니다.');
    if (!canEditNoticeComment(user, c)) {
        throw new Error('작성자 본인 또는 관리자만 수정할 수 있습니다.');
    }
    if (c.deleted_at) throw new Error('삭제된 댓글은 수정할 수 없습니다.');
    c.content = text;
    c.updated_at = new Date().toISOString();
    await save(db);
    return c;
}

/**
 * 공지 댓글 삭제 - 작성자 본인 또는 관리자.
 * 대댓글이 달린 댓글은 스레드를 지키기 위해 내용만 비운다(soft delete).
 */
export async function deleteNoticeComment(id, user) {
    const db = (await load());
    const c = db.noticeComments.find((x) => x.id === id);
    if (!c) throw new Error('댓글을 찾을 수 없습니다.');
    if (!canEditNoticeComment(user, c)) {
        throw new Error('작성자 본인 또는 관리자만 삭제할 수 있습니다.');
    }
    const hasReplies = db.noticeComments.some((x) => x.parent_id === id);
    if (hasReplies) {
        c.content = '';
        c.deleted_at = new Date().toISOString();
    } else {
        db.noticeComments = db.noticeComments.filter((x) => x.id !== id);
    }
    await save(db);
}

/* -------------------------------- 업무체크리스트 -------------------------------- */
/*
 * 항목 트리 한 그루가 업무 흐름이다 (docs/checklist.md).
 *   process   : 업무 단계. 형제 순서(sort_order)가 곧 업무 순서
 *   situation : 그 단계에서 생길 수 있는 상황. **발생 처리한 날짜에만** 하위가 끼어든다
 *   check     : 담당자가 실제로 체크하는 항목
 * 상황 발생은 별도 테이블 없이 **상황 노드에 그 날짜의 체크 기록**을 남기는 것으로 표현한다.
 * 담당자는 정담당자(assignee_id) 1명 + 부담당자(sub_assignees) 여러 명이고,
 * 체크항목 → 상위 프로세스 순으로 상속된다 (effectiveAssignee).
 */

/** 항목 등록·수정·삭제 권한 (체크는 담당자 본인도 한다) */
export function canManageChecklist(user) {
    return !!PERMISSION[user?.role]?.manageChecklist;
}

/**
 * 이 항목을 체크(상황이면 발생 처리)할 수 있는지.
 * 정담당자 본인, 부담당자 중 한 명, 담당자 미지정(공통 업무), 그리고 항목 관리 권한자(대신 체크)만
 * 가능하다. 담당자는 상위에서 상속된 값(`assignee_eff_id` · `assignee_eff_subs`)을 본다 -
 * checklistBoard 가 붙여 준다 (트리 항목은 effectiveAssignee 를 직접 부른다).
 * 🔑 웹·앱·서버 RLS(checklist_can_check) 가 모두 이 기준을 쓴다.
 */
export function canCheckItem(user, item) {
    if (!user || !item) return false;
    if (canManageChecklist(user)) return true;
    const inherited = item.assignee_eff_id !== undefined;
    const main = inherited ? item.assignee_eff_id : item.assignee_id;
    const subs = (inherited ? item.assignee_eff_subs : item.sub_assignees) ?? [];
    if (!main && !subs.length) return true;                  // 공통 업무
    return main === user.id || subs.some((s) => s.id === user.id);
}

/** 정렬 - 형제 순서(sort_order) → 등록순. 업무구분(최상위)·업무항목도 같은 규칙이다 */
function sortChecklist(rows) {
    return rows.slice().sort((a, b) => {
        if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) {
            return (a.sort_order ?? 0) - (b.sort_order ?? 0);
        }
        return String(a.created_at) > String(b.created_at) ? 1 : -1;
    });
}

/** 살아 있는 항목만 (soft delete 제외) */
function aliveItems(db) {
    return db.checklistItems.filter((i) => !i.deleted_at);
}

/**
 * 항목 목록 (삭제된 항목 제외).
 * @param {{root?:string, includeInactive?:boolean, assignee?:string, kind?:string}} f
 *   root            - 업무항목(group) id 를 주면 그 아래 전체(자기 포함)만
 *   includeInactive - 업무프로세스 탭은 비활성 항목까지 봐야 한다
 */
export async function listChecklistItems(f = {}) {
    let rows = aliveItems(await load());
    if (f.root) rows = withDescendants(rows, f.root);
    if (f.kind) rows = rows.filter((i) => i.kind === f.kind);
    if (!f.includeInactive) rows = rows.filter((i) => i.active);
    if (f.assignee) {
        rows = rows.filter((i) => i.assignee_id === f.assignee
            || (i.sub_assignees ?? []).some((s) => s.id === f.assignee));
    }
    return sortChecklist(rows);
}

/** 업무구분(최상위 division) 목록 - 비활성도 함께 준다 (업무프로세스 탭이 켜고 끈다) */
export async function listChecklistDivisions() {
    return sortChecklist(aliveItems(await load())
        .filter((i) => i.kind === CHECK_KIND.DIVISION && !i.parent_id));
}

/**
 * 업무항목(group) 목록 - 비활성도 함께 준다.
 * @param {string|null} [divisionId] 업무구분 id. 주지 않으면 전체, `null` 이면 업무구분이 없는
 *   옛 최상위 업무항목만 (스키마 마이그레이션 전 데이터 · mock)
 */
export async function listChecklistGroups(divisionId) {
    let rows = aliveItems(await load()).filter((i) => i.kind === CHECK_KIND.GROUP);
    if (divisionId === null) rows = rows.filter((i) => !i.parent_id);
    else if (divisionId) rows = rows.filter((i) => i.parent_id === divisionId);
    return sortChecklist(rows);
}

/**
 * 평평한 목록을 트리로 묶는다 (순수 함수).
 * 부모가 목록에 없는 항목은 최상위로 올려 화면에서 사라지지 않게 한다.
 * @returns {Array<{item:object, depth:number, children:Array}>}
 */
export function checklistTree(rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nodes = new Map(rows.map((r) => [r.id, { item: r, depth: 0, children: [] }]));
    const roots = [];
    sortChecklist(rows).forEach((r) => {
        const node = nodes.get(r.id);
        const parent = r.parent_id && byId.has(r.parent_id) ? nodes.get(r.parent_id) : null;
        if (parent) parent.children.push(node);
        else roots.push(node);
    });
    // 깊이는 다 이어 붙인 뒤에 센다 - 자식이 부모보다 먼저 처리되면 깊이가 어긋난다
    const setDepth = (node, depth) => {
        node.depth = depth;
        node.children.forEach((c) => setDepth(c, depth + 1));
    };
    roots.forEach((n) => setDepth(n, 0));
    return roots;
}

/**
 * 담당자 상속 🔑 - 자기 담당자(정 또는 부)가 없으면 가장 가까운 상위의 담당자를 쓴다.
 * 정·부는 한 묶음으로 상속된다 (상위에 정만 있으면 부도 비어 있는 채로 온다).
 * 끝까지 없으면 공통 업무(누구나 체크)다. 서버의 checklist_can_check() 와 같은 규칙이다.
 * @returns {{id:string|null, name:string, subs:Array<{id:string,name:string}>}}
 */
function effectiveAssignee(item, byId) {
    let cur = item;
    while (cur) {
        const subs = cur.sub_assignees ?? [];
        if (cur.assignee_id || subs.length) {
            return { id: cur.assignee_id ?? null, name: cur.assignee_name ?? '', subs };
        }
        cur = byId.get(cur.parent_id);
    }
    return { id: null, name: '', subs: [] };
}

/** 상위 중 상황(situation) 노드 id 들 - 모두 발생 처리돼야 이 항목이 오늘 대상에 든다 */
function situationAncestors(item, byId) {
    const out = [];
    let cur = byId.get(item.parent_id);
    while (cur) {
        if (cur.kind === CHECK_KIND.SITUATION) out.push(cur.id);
        cur = byId.get(cur.parent_id);
    }
    return out;
}

/** 이 종류의 부모 아래에 둘 수 있는 하위 종류 */
export function allowedChildKinds(parentKind) {
    return CHECK_KIND_CHILDREN[parentKind ?? 'root'] ?? [];
}

/**
 * 등록·수정 입력값 검증 - 종류·주기에 따라 필수값이 다르다.
 * @param {boolean} [relation=true] 상위-종류 관계를 검사할지. 수정에서 부모가 그대로면 건너뛴다
 *   (스키마 마이그레이션 전의 옛 최상위 업무항목도 이름·담당자를 고칠 수 있어야 한다)
 */
function checkItemInput(patch, base, db, parent, relation = true) {
    const title = String(patch.title ?? base.title ?? '').trim();
    if (!title) throw new Error('이름을 입력하세요.');

    const kind = patch.kind ?? base.kind ?? CHECK_KIND.CHECK;
    if (!Object.values(CHECK_KIND).includes(kind)) throw new Error('종류가 올바르지 않습니다.');
    if (relation && !allowedChildKinds(parent?.kind).includes(kind)) {
        const where = parent ? `${CHECK_KINDS[parent.kind]} 아래` : '최상위';
        throw new Error(`${where}에는 ${CHECK_KINDS[kind]}을(를) 둘 수 없습니다.`);
    }

    // category 는 최상위(업무구분) 이름이다 - 최상위는 자기 이름, 그 아래는 상위를 따른다 (옛 컬럼 호환).
    // 단, 독립 체크항목(최상위 + kind='check')은 트리가 아니라 일일체크리스트 구분값을 직접 받는다
    const category = parent
        ? parent.category
        : (kind === CHECK_KIND.CHECK
            ? String(patch.category ?? base.category ?? '').trim()
            : title);
    // 업무구분은 전체에서, 업무항목은 같은 업무구분 안에서 이름이 겹치면 안 된다
    if (kind === CHECK_KIND.DIVISION || kind === CHECK_KIND.GROUP) {
        const dup = aliveItems(db).find((i) => i.kind === kind && i.id !== base.id
            && (i.parent_id ?? null) === (parent?.id ?? null) && i.title === title);
        if (dup) throw new Error(`같은 이름의 ${CHECK_KINDS[kind]}이(가) 이미 있습니다: ${title}`);
    }

    // 주기는 체크항목만 뜻이 있다. 프로세스·상황은 daily 로 두고 화면에서 보이지 않는다
    const cycle = kind === CHECK_KIND.CHECK
        ? (patch.cycle ?? base.cycle ?? CHECK_CYCLE.DAILY)
        : CHECK_CYCLE.DAILY;
    if (!Object.values(CHECK_CYCLE).includes(cycle)) throw new Error('주기가 올바르지 않습니다.');

    let weekday = null;
    if (cycle === CHECK_CYCLE.WEEKLY) {
        weekday = Number(patch.weekday ?? base.weekday ?? 1);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
            throw new Error('요일을 선택하세요.');
        }
    }
    let monthday = null;
    if (cycle === CHECK_CYCLE.MONTHLY) {
        monthday = Number(patch.monthday ?? base.monthday ?? 1);
        if (!Number.isInteger(monthday) || monthday < 1 || monthday > 31) {
            throw new Error('일자는 1~31 사이로 입력하세요.');
        }
    }

    const assigneeId = patch.assignee_id === undefined ? base.assignee_id : patch.assignee_id;
    const assignee = assigneeId ? db.users.find((u) => u.id === assigneeId) : null;
    if (assigneeId && !assignee) throw new Error('정담당자를 찾을 수 없습니다.');

    // 부담당자 - 여러 명. 정담당자와 겹치거나 중복된 사람은 뺀다
    const subIds = patch.sub_assignee_ids !== undefined
        ? patch.sub_assignee_ids
        : (base.sub_assignees ?? []).map((s) => s.id);
    const subs = [];
    [...new Set((subIds ?? []).filter(Boolean))].forEach((id) => {
        if (id === assignee?.id) return;
        const u = db.users.find((x) => x.id === id);
        if (!u) throw new Error('부담당자를 찾을 수 없습니다.');
        subs.push({ id: u.id, name: u.name });
    });

    return {
        title,
        description: String(patch.description ?? base.description ?? '').trim(),
        category,
        kind,
        cycle,
        weekday,
        monthday,
        assignee_id: assignee?.id ?? null,
        assignee_name: assignee?.name ?? '',
        sub_assignees: subs,
        active: patch.active === undefined ? base.active !== false : !!patch.active,
        // 일일체크리스트 포함 여부 - 업무프로세스 탭에서 체크한 항목만 일일체크리스트에 나온다
        daily: patch.daily === undefined ? !!base.daily : !!patch.daily,
    };
}

/** 같은 부모를 둔 형제 (순서 계산용). 최상위면 업무항목들끼리다 */
function siblingsOf(db, parentId) {
    return sortChecklist(aliveItems(db)
        .filter((i) => (i.parent_id ?? null) === (parentId ?? null)));
}

/** 항목 등록 - 최상위는 업무구분만, 그 아래는 상위가 허용하는 종류만 (allowedChildKinds) */
export async function createChecklistItem(payload, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 등록할 권한이 없습니다.');
    const db = (await load());
    const row = insertChecklistItem(db, payload, user);
    await save(db);
    return row;
}

/**
 * 등록 한 건을 메모리에 넣는다 (createChecklistItem · seedChecklistTemplate 공용).
 * @param {{edge?:boolean, relation?:boolean}} [opt]
 *   edge:false     흐름 간선을 만들지 않는다 (복제는 원본 간선을 그대로 옮긴다)
 *   relation:false 상위-종류 관계 검사를 건너뛴다. 🔑 **복제만** 쓴다 - 이미 저장된
 *                  옛 중첩 프로세스(프로세스 아래 프로세스)를 그대로 옮겨야 하기 때문이다
 */
function insertChecklistItem(db, payload, user, opt = {}) {
    const parentId = payload.parent_id || null;
    const parent = parentId
        ? aliveItems(db).find((x) => x.id === parentId)
        : null;
    if (parentId && !parent) throw new Error('상위 항목을 찾을 수 없습니다.');

    const v = checkItemInput(payload, {}, db, parent, opt.relation !== false);
    const last = siblingsOf(db, parentId).at(-1);
    const row = {
        id: uid('ci'),
        parent_id: parentId,
        ...v,
        sort_order: (last?.sort_order ?? 0) + 1,
        created_by: user.id,
        created_by_name: user.name,
        created_at: new Date().toISOString(),
        updated_at: null,
        deleted_at: null,
    };
    db.checklistItems.push(row);
    // 🔑 프로세스는 흐름(간선)에도 넣는다 - 간선이 없으면 그 단계가 흐름의 시작이 되어
    // 같은 층에 여러 개가 서고 번호가 `1.1` `1.2` 로 갈린다
    if (opt.edge !== false) linkNewStep(db, row, payload, user);
    return row;
}

/**
 * 견본(config.js 의 CHECK_TEMPLATES)으로 업무구분 아래에 업무항목 한 벌을 만든다.
 * 그 업무구분에 같은 이름의 업무항목이 이미 있으면 거부한다 (흐름이 두 벌 생기지 않게).
 * @param {string} name 견본 이름 (= 만들 업무항목 이름)
 * @param {string} divisionId 업무항목을 넣을 업무구분
 * @returns {{group:object, count:number}} 만든 업무항목과 등록한 항목 수(업무항목 포함)
 */
export async function seedChecklistTemplate(name, divisionId, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 등록할 권한이 없습니다.');
    const tpl = CHECK_TEMPLATES[name];
    if (!tpl?.length) throw new Error('견본이 없는 업무항목입니다.');
    const db = (await load());
    const group = insertChecklistItem(db, {
        kind: CHECK_KIND.GROUP, title: name, parent_id: divisionId,
    }, user);
    let count = 1;
    const walk = (nodes, parentId) => {
        nodes.forEach((n) => {
            const row = insertChecklistItem(db, {
                parent_id: parentId,
                kind: n.kind ?? CHECK_KIND.CHECK,
                title: n.title,
                description: n.description ?? '',
                daily: true,             // 견본 항목은 모두 일일체크리스트에 포함
            }, user);
            count += 1;
            if (n.children?.length) walk(n.children, row.id);
        });
    };
    walk(tpl, group.id);
    await save(db);
    return { group, count };
}

/**
 * 업무항목 복제 🔑 - 프로세스·상황·체크항목까지 통째로 복사해 같은 업무구분 맨 뒤에 둔다.
 * 비슷한 흐름(B2B출고 → B2C출고)을 처음부터 다시 짜지 않게 한다. 체크 기록은 복사하지 않는다.
 * @returns {{group:object, count:number}} 새 업무항목과 복사한 항목 수(업무항목 포함)
 */
export async function duplicateChecklistGroup(id, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 등록할 권한이 없습니다.');
    const db = (await load());
    const alive = aliveItems(db);
    const src = alive.find((x) => x.id === id && x.kind === CHECK_KIND.GROUP);
    if (!src) throw new Error('복제할 업무항목을 찾을 수 없습니다.');

    // 겹치지 않는 이름을 고른다 - 「이름 복사」 「이름 복사 2」 …
    const siblings = alive.filter((x) => x.kind === CHECK_KIND.GROUP
        && (x.parent_id ?? null) === (src.parent_id ?? null)).map((x) => x.title);
    let title = `${src.title} 복사`;
    for (let n = 2; siblings.includes(title); n += 1) title = `${src.title} 복사 ${n}`;

    let count = 0;
    const map = new Map();          // 원본 id → 복사본 id (간선을 옮길 때 쓴다)
    const copy = (item, parentId, newTitle) => {
        const row = insertChecklistItem(db, {
            parent_id: parentId,
            kind: item.kind,
            title: newTitle ?? item.title,
            description: item.description,
            cycle: item.cycle,
            weekday: item.weekday,
            monthday: item.monthday,
            assignee_id: item.assignee_id,
            sub_assignee_ids: (item.sub_assignees ?? []).map((s) => s.id),
            active: item.active,
            daily: item.daily,
        }, user, { edge: false, relation: false });
        count += 1;
        map.set(item.id, row.id);
        sortChecklist(alive.filter((c) => c.parent_id === item.id))
            .forEach((c) => copy(c, row.id));
        return row;
    };
    const group = copy(src, src.parent_id, title);
    // 🔑 흐름 간선도 함께 옮긴다 - 간선을 빼먹으면 복사본의 단계가 전부 시작 노드가 된다
    sortEdges(db.checklistEdges.filter((e) => e.group_id === id)).forEach((e) => {
        if (!map.has(e.to_id) || (e.from_id && !map.has(e.from_id))) return;
        pushEdge(db, {
            groupId: group.id,
            fromId: e.from_id ? map.get(e.from_id) : null,
            toId: map.get(e.to_id),
            label: e.label,
            sortOrder: e.sort_order,
        }, user);
    });
    await save(db);
    return { group, count };
}

/** 하위 항목을 모두 모은다 (자기 자신 포함) */
function withDescendants(rows, id) {
    const out = [];
    const walk = (parentId) => {
        rows.filter((r) => r.parent_id === parentId).forEach((r) => {
            out.push(r);
            walk(r.id);
        });
    };
    const me = rows.find((r) => r.id === id);
    if (me) out.push(me);
    walk(id);
    return out;
}

/**
 * 항목 수정. 최상위 이름을 바꾸면 하위의 category(옛 컬럼)도 함께 맞춘다.
 * 종류(kind)는 바꾸지 않는다 - 하위 구조가 달라져야 해서 지우고 다시 만든다.
 * **업무항목은 `parent_id` 로 다른 업무구분으로 옮길 수 있다** (형제 맨 뒤로 간다).
 */
export async function updateChecklistItem(id, patch, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 수정할 권한이 없습니다.');
    const db = (await load());
    const item = aliveItems(db).find((x) => x.id === id);
    if (!item) throw new Error('체크리스트 항목을 찾을 수 없습니다.');

    let parentId = item.parent_id ?? null;
    let reparented = false;
    const wantParent = patch.parent_id === undefined ? undefined : (patch.parent_id || null);
    if (item.kind === CHECK_KIND.GROUP && wantParent !== undefined && wantParent !== parentId) {
        reparented = true;
        const target = wantParent ? aliveItems(db).find((x) => x.id === wantParent) : null;
        if (wantParent && !target) throw new Error('옮길 업무구분을 찾을 수 없습니다.');
        parentId = wantParent;
        item.parent_id = parentId;
        const last = siblingsOf(db, parentId).filter((x) => x.id !== id).at(-1);
        item.sort_order = (last?.sort_order ?? 0) + 1;
    }
    const parent = parentId ? db.checklistItems.find((x) => x.id === parentId) : null;
    const v = checkItemInput({ ...patch, kind: item.kind }, item, db, parent, reparented);
    const moved = v.category !== item.category;
    Object.assign(item, v, { updated_at: new Date().toISOString() });
    if (moved) {
        withDescendants(aliveItems(db), id).forEach((x) => { x.category = v.category; });
    }
    await save(db);
    return item;
}

/** 형제 사이에서 순서를 한 칸 옮긴다. dir 은 'up' 또는 'down' */
export async function moveChecklistItem(id, dir, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 수정할 권한이 없습니다.');
    const db = (await load());
    const item = aliveItems(db).find((x) => x.id === id);
    if (!item) throw new Error('체크리스트 항목을 찾을 수 없습니다.');

    const rows = siblingsOf(db, item.parent_id);
    const at = rows.findIndex((x) => x.id === id);
    const swap = rows[dir === 'up' ? at - 1 : at + 1];
    if (!swap) return item;      // 맨 위/맨 아래면 그대로 둔다

    // 값이 겹쳐 있어도 자리가 바뀌도록 순번을 다시 매긴 뒤 맞바꾼다
    rows.forEach((r, i) => { r.sort_order = i + 1; });
    const mine = item.sort_order;
    item.sort_order = swap.sort_order;
    swap.sort_order = mine;
    await save(db);
    return item;
}

/**
 * 형제 안에서 여러 항목의 순서를 한 번에 정한다 (드래그 정렬용).
 * orderedIds 의 항목들이 원래 차지하던 자리를 새 순서로 다시 채운다.
 * 목록에 없는 형제(다른 종류의 항목 등)는 제자리를 지킨다.
 * @param {string|null} parentId 상위 항목 id (최상위면 null)
 * @param {string[]} orderedIds 새 순서의 항목 id 목록 (모두 같은 상위 아래여야 한다)
 */
export async function reorderChecklistItems(parentId, orderedIds, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 수정할 권한이 없습니다.');
    const db = (await load());
    const rows = siblingsOf(db, parentId || null);
    const ids = [...new Set(orderedIds)];
    if (ids.some((id) => !rows.some((r) => r.id === id))) {
        throw new Error('같은 상위 아래의 항목끼리만 순서를 바꿀 수 있습니다.');
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const slots = rows.map((r, i) => (ids.includes(r.id) ? i : -1)).filter((i) => i >= 0);
    const next = rows.slice();
    slots.forEach((pos, k) => { next[pos] = byId.get(ids[k]); });
    next.forEach((r, i) => { r.sort_order = i + 1; });
    await save(db);
}

/**
 * 항목 삭제 - 하위 항목까지 함께 지운다.
 * 체크 기록을 남겨 두려고 행을 지우지 않고 deleted_at 만 찍는다(soft delete).
 * 🔑 단계(프로세스)를 지우면 **흐름을 먼저 잇는다** - 앞뒤를 잇지 않으면 뒷 단계가
 * 시작 노드가 되어 1층으로 튄다 (bridgeEdges · 확인 문구는 bridgeInfo).
 */
export async function deleteChecklistItem(id, user) {
    if (!canManageChecklist(user)) throw new Error('체크리스트 항목을 삭제할 권한이 없습니다.');
    const db = (await load());
    const alive = aliveItems(db);
    const targets = withDescendants(alive, id);
    if (!targets.length) throw new Error('체크리스트 항목을 찾을 수 없습니다.');
    const now = new Date().toISOString();
    bridgeEdges(db, targets, new Map(alive.map((i) => [i.id, i])), user);
    targets.forEach((x) => { x.deleted_at = now; });
    await save(db);
    return targets.length;
}

/* ----------------------------- 업무 흐름 간선 (DAG) ----------------------------- */
/*
 * 소유와 흐름을 나눈다 🔑 (docs/checklist.md).
 *   parent_id · sort_order  소유 - 업무항목 소속 · 담당자 상속 · 삭제 전파 · RLS
 *   checklist_edges         흐름 - 단계 순서의 **유일한 출처**. 갈래·합류를 함께 푼다
 * 그래서 담당자 상속(effectiveAssignee)·체크 권한(canCheckItem)·주기 판정(isDueOn)은
 * 간선을 보지 않는다. 간선이 정하는 것은 **프로세스 번호(no)** 뿐이다.
 *
 * 흐름 한 벌의 경계는 업무항목(group) 하나다. 상황(situation) 아래 대응 프로세스는
 * 간선에 넣지 않는다 - 갈래는 「늘 있는 경로」, 상황은 「그날 생긴 일」이라 층이 다르다.
 */

/** 간선 순서 - 같은 from 에서 갈라진 갈래의 좌→우 (sort_order → 등록순 → id) */
function sortEdges(rows) {
    return rows.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
        || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
        || String(a.id).localeCompare(String(b.id)));
}

/**
 * 그 항목이 속한 흐름의 경계(업무항목 id). **흐름 노드가 아니면 null** 이다.
 * 프로세스만 흐름에 들고, 상황 아래 대응 프로세스는 빠진다 (트리 + sort_order 로 남는다).
 */
function flowGroupOf(item, byId) {
    if (!item || item.kind !== CHECK_KIND.PROCESS) return null;
    if (situationAncestors(item, byId).length) return null;
    let cur = byId.get(item.parent_id);
    while (cur) {
        if (cur.kind === CHECK_KIND.GROUP) return cur.id;
        cur = byId.get(cur.parent_id);
    }
    return null;
}

/** 그 업무항목의 흐름 노드 (프로세스 · 상황 아래 제외) */
function flowNodesOf(items, byId, groupId) {
    return sortChecklist(items.filter((i) => flowGroupOf(i, byId) === groupId));
}

/** 그 업무항목의 간선 (양 끝이 흐름 노드인 것만 · 순서 정렬) */
function edgesOfGroup(db, groupId, byId) {
    const ids = new Set(flowNodesOf(aliveItems(db), byId, groupId).map((i) => i.id));
    return sortEdges(db.checklistEdges.filter((e) => ids.has(e.to_id)
        && (!e.from_id || ids.has(e.from_id))));
}

/**
 * 빠진 노드를 건너뛰어 간선을 잇는다 (비활성 노드를 뺄 때 · 순수 함수).
 * 잇지 않으면 사슬이 끊겨 뒷 단계가 1층으로 올라간다 - 옛 sort_order 채번과 달라진다.
 * @param {Array} edges 간선 전부
 * @param {Set<string>} keep 남길 노드 id
 */
function contractEdges(edges, keep) {
    const byFrom = new Map();
    sortEdges(edges).forEach((e) => {
        const k = e.from_id ?? '';
        if (!byFrom.has(k)) byFrom.set(k, []);
        byFrom.get(k).push(e);
    });
    const out = [];
    const added = new Set();
    /** 도착이 빠진 노드면 그 뒤로 계속 내려가 처음 만나는 남긴 노드까지 잇는다 */
    const relay = (src, e, hops) => {
        if (keep.has(e.to_id)) {
            const key = `${src ?? ''}>${e.to_id}`;
            if (added.has(key)) return;
            added.add(key);
            out.push((e.from_id ?? null) === src ? e : { ...e, id: null, from_id: src });
            return;
        }
        if (hops.has(e.to_id)) return;              // 순환 방어
        hops.add(e.to_id);
        (byFrom.get(e.to_id) ?? []).forEach((n) => relay(src, n, hops));
    };
    [...byFrom.keys()].forEach((k) => {
        if (k !== '' && !keep.has(k)) return;       // 빠진 노드에서 나가는 간선은 위에서 이어 준다
        byFrom.get(k).forEach((e) => relay(k === '' ? null : k, e, new Set()));
    });
    return out;
}

/** startId 에서 간선을 따라 닿는 노드 id (reverse 면 거꾸로 - 나를 가리키는 쪽) */
function reachOf(edges, startId, reverse = false) {
    const next = new Map();
    edges.forEach((e) => {
        if (!e.from_id) return;
        const [a, b] = reverse ? [e.to_id, e.from_id] : [e.from_id, e.to_id];
        if (!next.has(a)) next.set(a, []);
        next.get(a).push(b);
    });
    const out = new Set();
    const stack = [startId];
    while (stack.length) {
        (next.get(stack.pop()) ?? []).forEach((id) => {
            if (out.has(id)) return;
            out.add(id);
            stack.push(id);
        });
    }
    return out;
}

/**
 * 갈래 지점마다 **모든 갈래가 다시 모이는 첫 단계** 🔑 (없으면 null).
 * 즉시 다음 단계만 교집합하면 「갈래 A 는 3단계 뒤에 합류」를 놓친다. 그래서 갈래마다
 * **닿는 단계 전부**를 모아 교집합하고 그중 가장 이른 층을 고른다.
 * @param {Array} order 흐름 순서의 id (같은 층이면 이 순서로 앞뒤를 가른다)
 */
function joinsOf(nodes, layer, nexts, order) {
    const at = new Map(order.map((id, i) => [id, i]));
    const out = {};
    nodes.forEach((n) => {
        const branches = [...new Set(nexts[n.id] ?? [])];
        if (branches.length < 2) return;
        const reach = branches.map((id) => {
            const seen = new Set([id]);
            const stack = [id];
            while (stack.length) {
                (nexts[stack.pop()] ?? []).forEach((w) => {
                    if (seen.has(w)) return;
                    seen.add(w);
                    stack.push(w);
                });
            }
            return seen;
        });
        const common = [...reach[0]].filter((id) => reach.every((s) => s.has(id)))
            .sort((a, b) => (layer[a] - layer[b]) || (at.get(a) - at.get(b)));
        out[n.id] = common[0] ?? null;
    });
    return out;
}

/**
 * 흐름의 층·번호 🔑 (순수 함수 · **판정은 이 함수 한 곳**).
 * 캡션·앱·인쇄·도식이 모두 이 결과만 읽는다.
 *
 * 🔑 **층·층 내 순서·번호는 `checkflow.flowNos` 에 맡긴다.** 여기서 따로 계산하면
 * (예전에는 들어오는 간선의 `min(sort_order)` 로 층 내 순서를 정했다) 도식이 쓰는
 * `layoutDag` 의 열 순서(median 정렬)와 어긋나 `5.1` 이 `5.2` 오른쪽에 그려졌다.
 * `checkflow.js` 는 `steps.js` 와 같은 순수 공용층이라 앱·웹·여기서 모두 쓸 수 있다.
 *
 *   층      `layer(v) = 1 + max(layer(선행자))` · 시작 노드는 1 (Kahn 위상정렬 · 최장경로)
 *   번호    층에 노드가 하나면 정수 문자열(캡션이 ①②③ 로 그린다), 둘 이상이면 **`층.k`**
 *           (`4.1` `4.2` · k = 층 안의 좌→우 = 도식의 열 순서와 같다)
 *   순환    넣을 때 막지만(addProcessEdge), 남아 있으면 마지막 층으로 격리하고 `cyclic` 로 알린다
 *
 * 번호는 저장하지 않는다 - 간선이 바뀌면 그때그때 다시 계산한다.
 * @returns {{nodes, edges, layer, no, order, layers, nexts, preds, joinTarget,
 *            entries, exits, cyclic}}
 *   nodes   흐름 순서(층 → 좌→우)로 놓인 노드 · order 같은 순서의 id 배열
 *   layers  층별 노드 id (도식의 열 순서와 같다) · nexts[id] 나가는 간선의 to_id
 *   joinTarget[갈래지점] 갈래가 다시 모이는 단계 (웹·앱 캡션이 이것만 읽는다)
 *   entries 들어오는 간선이 없는 노드 · exits 나가는 간선이 없는 노드
 */
function flowOf(nodes, edges) {
    const pos = new Map(nodes.map((n, i) => [n.id, i]));
    const rows = sortEdges(edges).filter((e) => pos.has(e.to_id)
        && (!e.from_id || pos.has(e.from_id)));
    const preds = {};
    const nexts = {};
    nodes.forEach((n) => { preds[n.id] = []; nexts[n.id] = []; });
    rows.forEach((e) => {
        if (!e.from_id) return;                     // 시작 간선은 선행자가 아니다
        nexts[e.from_id].push(e.to_id);
        preds[e.to_id].push(e.from_id);
    });
    const flow = flowNos(nodes, rows.map((e) => ({
        from: e.from_id ?? null, to: e.to_id, sort_order: e.sort_order,
    })));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
        nodes: flow.order.map((id) => byId.get(id)),
        edges: rows,
        layer: flow.layer,
        no: flow.no,
        order: flow.order,
        layers: flow.layers,
        nexts,
        preds,
        joinTarget: joinsOf(nodes, flow.layer, nexts, flow.order),
        entries: nodes.filter((n) => !preds[n.id].length).map((n) => n.id),
        exits: nodes.filter((n) => !nexts[n.id].length).map((n) => n.id),
        cyclic: flow.cyclic,
    };
}

/**
 * 저장 데이터에서 흐름을 만든다 (processFlow 가 쓴다).
 * @param {{includeInactive?:boolean}} opt 업무프로세스 탭은 비활성 단계까지 본다.
 *   비활성을 뺄 때는 **간선을 이어 준다**(contractEdges) - 끊으면 뒷 단계가 1층으로 튄다
 */
function flowFromDb(db, groupId, opt = {}) {
    const alive = aliveItems(db);
    const byId = new Map(alive.map((i) => [i.id, i]));
    const all = flowNodesOf(alive, byId, groupId);
    const nodes = opt.includeInactive ? all : all.filter((n) => n.active);
    const ids = new Set(all.map((n) => n.id));
    const edges = db.checklistEdges.filter((e) => ids.has(e.to_id)
        && (!e.from_id || ids.has(e.from_id)));
    return flowOf(nodes, contractEdges(edges, new Set(nodes.map((n) => n.id))));
}

/**
 * 업무항목 하나의 흐름 🔑 - 캡션·앱·인쇄·도식이 모두 이것만 읽는다 (flowOf 참고).
 * 조회 함수라 권한 가드를 두지 않는다 - 현장작업자도 흐름을 읽어야 한다 (편집만 가드).
 * @param {string} groupId 업무항목 id
 * @param {{includeInactive?:boolean}} [opt] 업무프로세스 탭은 `true`
 */
export async function processFlow(groupId, opt = {}) {
    return flowFromDb(await load(), groupId, opt);
}

/**
 * 그 단계에서 간선을 따라 닿는 단계 id 목록.
 * 🔑 **연결 모드에서 순환이 되는 후보는 `{reverse: true}` 다** - `from → to` 를 새로 잇는 것이
 * 순환이 되는 조건은 「to 에서 from 으로 닿는다」 = from 의 선행자들이다.
 * @param {{reverse?:boolean}} [opt] reverse 면 거꾸로 (나를 가리키는 쪽)
 */
export async function reachableFrom(groupId, fromId, opt = {}) {
    const db = (await load());
    const byId = new Map(aliveItems(db).map((i) => [i.id, i]));
    return [...reachOf(edgesOfGroup(db, groupId, byId), fromId, !!opt.reverse)];
}

/** 간선 한 줄을 메모리에 넣는다 (중복·시작 간선 중복이면 null) */
function pushEdge(db, e, user) {
    const same = db.checklistEdges.some((x) => (x.from_id ?? null) === (e.fromId ?? null)
        && x.to_id === e.toId);
    // 시작 간선은 to 마다 하나만 둔다 (스키마의 부분 unique 와 같은 규칙)
    const entryDup = !e.fromId && db.checklistEdges.some((x) => !x.from_id && x.to_id === e.toId);
    if (same || entryDup) return null;
    // 🔑 같은 업무항목 안에서만 센다 - from 이 null(시작 간선)이면 업무항목 전부가 섞인다
    const mine = sortEdges(db.checklistEdges
        .filter((x) => (x.from_id ?? null) === (e.fromId ?? null)
            && (x.group_id ?? null) === (e.groupId ?? null)));
    const row = {
        id: uid('ce'),
        group_id: e.groupId,
        from_id: e.fromId ?? null,
        to_id: e.toId,
        label: String(e.label ?? '').trim(),
        sort_order: Number.isFinite(e.sortOrder)
            ? Number(e.sortOrder)
            : (mine.at(-1)?.sort_order ?? 0) + 1,
        created_by: user?.id ?? null,
        created_by_name: user?.name ?? '',
        created_at: new Date().toISOString(),
    };
    db.checklistEdges.push(row);
    return row;
}

/**
 * 단계를 잇는다 🔑 - 넣기 전에 순환·자기참조·중복·다른 업무항목을 거부한다.
 * @param {string|null} fromId 출발 단계. **null 이면 흐름의 시작(entry)**
 * @param {string} toId 도착 단계
 * @param {{label?:string, sortOrder?:number}} [patch] label 조건 라벨 · sortOrder 갈래 좌→우
 */
export async function addProcessEdge(fromId, toId, patch = {}, user) {
    if (!canManageChecklist(user)) throw new Error('업무 흐름을 편집할 권한이 없습니다.');
    const db = (await load());
    const byId = new Map(aliveItems(db).map((i) => [i.id, i]));
    const to = byId.get(toId);
    if (!to) throw new Error('이을 단계를 찾을 수 없습니다.');
    if (fromId && !byId.get(fromId)) throw new Error('출발 단계를 찾을 수 없습니다.');
    if (fromId && fromId === toId) throw new Error('같은 단계끼리는 이을 수 없습니다.');
    const groupId = flowGroupOf(to, byId);
    if (!groupId) throw new Error('흐름에 넣을 수 없는 단계입니다 (프로세스만 · 상황 아래 제외).');
    if (fromId && flowGroupOf(byId.get(fromId), byId) !== groupId) {
        throw new Error('같은 업무항목 안의 단계끼리만 이을 수 있습니다.');
    }
    const edges = edgesOfGroup(db, groupId, byId);
    if (!fromId && edges.some((e) => !e.from_id && e.to_id === toId)) {
        throw new Error('이미 흐름의 시작인 단계입니다.');
    }
    if (edges.some((e) => (e.from_id ?? null) === (fromId ?? null) && e.to_id === toId)) {
        throw new Error('이미 이어진 연결입니다.');
    }
    if (fromId && reachOf(edges, toId).has(fromId)) {
        throw new Error('흐름이 되돌아가는 연결입니다 (순환).');
    }
    const row = pushEdge(db, {
        groupId, fromId: fromId || null, toId, label: patch.label, sortOrder: patch.sortOrder,
    }, user);
    await save(db);
    return row;
}

/** 연결을 지운다. 간선은 soft delete 가 아니다 - 남겨 두면 층 계산이 틀린다 */
export async function removeProcessEdge(edgeId, user) {
    if (!canManageChecklist(user)) throw new Error('업무 흐름을 편집할 권한이 없습니다.');
    const db = (await load());
    const at = db.checklistEdges.findIndex((e) => e.id === edgeId);
    if (at < 0) throw new Error('연결을 찾을 수 없습니다.');
    const [gone] = db.checklistEdges.splice(at, 1);
    await save(db);
    return gone;
}

/** 조건 라벨 (「국내」 「수량 오류 시」) */
export async function setEdgeLabel(edgeId, label, user) {
    if (!canManageChecklist(user)) throw new Error('업무 흐름을 편집할 권한이 없습니다.');
    const db = (await load());
    const edge = db.checklistEdges.find((e) => e.id === edgeId);
    if (!edge) throw new Error('연결을 찾을 수 없습니다.');
    edge.label = String(label ?? '').trim();
    await save(db);
    return edge;
}

/**
 * 같은 단계에서 갈라진 갈래의 좌→우 순서를 한 번에 정한다.
 * 🔑 **반드시 업무항목(`group_id`) 안으로 좁힌다.** `from_id` 만 보면 시작 간선(null)이
 * 모든 업무항목에 걸쳐 있어, 한 업무항목의 갈래 순서를 바꾸면 **남의 업무항목 시작 순서까지**
 * 다시 쓰였다 (데이터 오염).
 * @param {string|null} fromId 출발 단계 (null 이면 그 업무항목 흐름의 시작들)
 * @param {string[]} orderedToIds 새 순서의 도착 단계 id
 */
export async function reorderEdges(fromId, orderedToIds, user) {
    if (!canManageChecklist(user)) throw new Error('업무 흐름을 편집할 권한이 없습니다.');
    const db = (await load());
    const ids = [...new Set(orderedToIds)];
    if (!ids.length) throw new Error('순서를 바꿀 연결이 없습니다.');
    const byId = new Map(aliveItems(db).map((i) => [i.id, i]));
    const groupOf = (e) => e.group_id ?? flowGroupOf(byId.get(e.to_id), byId) ?? null;
    const scope = flowGroupOf(byId.get(ids[0]), byId) ?? null;
    const rows = sortEdges(db.checklistEdges
        .filter((e) => (e.from_id ?? null) === (fromId || null) && groupOf(e) === scope));
    if (ids.some((id) => !rows.some((r) => r.to_id === id))) {
        throw new Error('같은 단계에서 갈라진 연결끼리만 순서를 바꿀 수 있습니다.');
    }
    ids.forEach((id, i) => { rows.find((r) => r.to_id === id).sort_order = i + 1; });
    rows.filter((r) => !ids.includes(r.to_id))
        .forEach((r, i) => { r.sort_order = ids.length + i + 1; });
    await save(db);
}

/**
 * 지울 대상의 앞뒤를 가린다 (브릿지 계획).
 * 지우는 범위는 항목과 하위 전부(soft delete 와 같은 범위)라 **묶음 밖의** 앞뒤만 본다.
 * prev 의 id 가 null 이면 흐름의 시작이다.
 */
function bridgePlan(db, targets) {
    const tset = new Set(targets.map((t) => t.id));
    const edges = sortEdges(db.checklistEdges);
    const prev = [];
    edges.filter((e) => tset.has(e.to_id) && !tset.has(e.from_id ?? '')).forEach((e) => {
        const id = e.from_id ?? null;
        if (!prev.some((x) => x.id === id)) {
            prev.push({ id, label: e.label ?? '', sort: e.sort_order ?? 0 });
        }
    });
    const next = [];
    edges.filter((e) => e.from_id && tset.has(e.from_id) && !tset.has(e.to_id)).forEach((e) => {
        if (!next.includes(e.to_id)) next.push(e.to_id);
    });
    return { tset, prev, next };
}

/**
 * 지운 단계의 앞뒤를 잇는다 🔑 - `{a→x}` `{x→b}` 를 지우고 **데카르트곱 `a→b`** 를 만든다.
 * 중복은 만들지 않는다 (스키마의 unique 와 같은 규칙).
 *
 * 🔑 **`sort_order` 는 곱마다 다르게** 준다 - 같은 값을 넣으면 갈래의 좌우가 저장 순서에
 * 따라 흔들려, 지우기 전후로 도식이 뒤바뀐 적이 있다.
 * 🔑 **조건 라벨은 next 가 하나일 때만 물려받는다** - 「국내」 갈래를 지웠다고 여러 갈래에
 * 모두 「국내」를 붙이면 뜻이 틀린다.
 */
function bridgeEdges(db, targets, byId, user) {
    const { tset, prev, next } = bridgePlan(db, targets);
    db.checklistEdges = db.checklistEdges
        .filter((e) => !tset.has(e.to_id) && !tset.has(e.from_id ?? ''));
    if (!prev.length || !next.length) return;
    prev.forEach((p) => {
        next.forEach((toId, i) => {
            pushEdge(db, {
                groupId: flowGroupOf(byId.get(toId), byId),
                fromId: p.id,
                toId,
                label: next.length === 1 ? p.label : '',
                sortOrder: p.sort + i,
            }, user);
        });
    });
}

/**
 * 단계를 지우면 어디가 이어지는지 (확인 문구용) 🔑 - 화면이 「③ 와 ⑤ 를 잇습니다」 를 띄운다.
 * @returns {Promise<{prev:Array, next:Array}>} `{id, title, no}` · prev 의 id 가 null 이면 시작
 */
export async function bridgeInfo(id) {
    const db = (await load());
    const alive = aliveItems(db);
    const byId = new Map(alive.map((i) => [i.id, i]));
    const targets = withDescendants(alive, id);
    const node = targets.find((t) => flowGroupOf(t, byId));
    if (!node) return { prev: [], next: [] };
    const flow = flowFromDb(db, flowGroupOf(node, byId), { includeInactive: true });
    const { prev, next } = bridgePlan(db, targets);
    const info = (nid) => (nid
        ? { id: nid, title: byId.get(nid)?.title ?? '', no: flow.no[nid] ?? null }
        : { id: null, title: '시작', no: null });
    return { prev: prev.map((p) => info(p.id)), next: next.map((n) => info(n)) };
}

/**
 * 새 프로세스를 흐름에 잇는다 🔑 (등록·견본 공용).
 * 흐름 순서는 간선이 유일한 출처라 **단계를 만들 때 간선도 함께** 만들어야 사슬이 끊기지 않는다.
 * `payload.from_id` 를 주면 그 단계 뒤에, `null` 이면 흐름의 시작으로, 주지 않으면 맨 뒤에 붙인다
 * (종전의 「형제 맨 뒤」 와 같은 자리다).
 */
function linkNewStep(db, row, payload, user) {
    const byId = new Map(aliveItems(db).map((i) => [i.id, i]));
    const groupId = flowGroupOf(row, byId);
    if (!groupId) return;                    // 상황 아래 대응 프로세스는 트리로 남는다
    const flow = flowFromDb(db, groupId, { includeInactive: true });
    const before = flow.order.filter((x) => x !== row.id);
    const fromId = payload.from_id === undefined
        ? (before.at(-1) ?? null)
        : (payload.from_id || null);
    if (fromId && !before.includes(fromId)) throw new Error('앞에 둘 단계를 찾을 수 없습니다.');
    pushEdge(db, { groupId, fromId, toId: row.id, label: payload.edge_label }, user);
}

/* --------------------------- 프로세스 설명 표 (구분·내용·비고) --------------------------- */
/*
 * 단계 하나에 붙는 설명 표. item_id 는 프로세스·업무항목·상황 어느 것이든 된다 (같은 표가 붙는다).
 * ⚠️ 체크리스트에서 **유일하게 하드 삭제**다 - 체크 기록과 이어지지 않아 되살릴 이유가 없다.
 */

/** 설명 줄 순서 (sort_order → 등록순) */
function sortNotes(rows) {
    return rows.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
        || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

/** 그 항목의 설명 표 */
export async function listChecklistNotes(itemId) {
    return sortNotes((await load()).checklistNotes.filter((n) => n.item_id === itemId));
}

/** 설명 줄 추가 (맨 뒤) */
export async function createChecklistNote(itemId, patch = {}, user) {
    if (!canManageChecklist(user)) throw new Error('설명을 편집할 권한이 없습니다.');
    const db = (await load());
    if (!aliveItems(db).some((x) => x.id === itemId)) {
        throw new Error('설명을 붙일 항목을 찾을 수 없습니다.');
    }
    const last = sortNotes(db.checklistNotes.filter((n) => n.item_id === itemId)).at(-1);
    const row = {
        id: uid('cn'),
        item_id: itemId,
        label: String(patch.label ?? '').trim(),
        content: String(patch.content ?? '').trim(),
        remark: String(patch.remark ?? '').trim(),
        sort_order: (last?.sort_order ?? 0) + 1,
        created_by: user.id,
        created_by_name: user.name,
        created_at: new Date().toISOString(),
        updated_at: null,
    };
    db.checklistNotes.push(row);
    await save(db);
    return row;
}

/** 설명 줄 수정 (구분·내용·비고만) */
export async function updateChecklistNote(id, patch = {}, user) {
    if (!canManageChecklist(user)) throw new Error('설명을 편집할 권한이 없습니다.');
    const db = (await load());
    const note = db.checklistNotes.find((n) => n.id === id);
    if (!note) throw new Error('설명 줄을 찾을 수 없습니다.');
    ['label', 'content', 'remark'].forEach((k) => {
        if (patch[k] !== undefined) note[k] = String(patch[k]).trim();
    });
    note.updated_at = new Date().toISOString();
    await save(db);
    return note;
}

/** 설명 줄 삭제 - ⚠️ 하드 삭제다 */
export async function deleteChecklistNote(id, user) {
    if (!canManageChecklist(user)) throw new Error('설명을 편집할 권한이 없습니다.');
    const db = (await load());
    const at = db.checklistNotes.findIndex((n) => n.id === id);
    if (at < 0) throw new Error('설명 줄을 찾을 수 없습니다.');
    const [gone] = db.checklistNotes.splice(at, 1);
    await save(db);
    return gone;
}

/** 설명 줄 순서 (드래그 정렬) */
export async function reorderChecklistNotes(itemId, orderedIds, user) {
    if (!canManageChecklist(user)) throw new Error('설명을 편집할 권한이 없습니다.');
    const db = (await load());
    const rows = sortNotes(db.checklistNotes.filter((n) => n.item_id === itemId));
    const ids = [...new Set(orderedIds)];
    if (ids.some((id) => !rows.some((r) => r.id === id))) {
        throw new Error('같은 항목의 설명끼리만 순서를 바꿀 수 있습니다.');
    }
    ids.forEach((id, i) => { rows.find((r) => r.id === id).sort_order = i + 1; });
    rows.filter((r) => !ids.includes(r.id))
        .forEach((r, i) => { r.sort_order = ids.length + i + 1; });
    await save(db);
}

/** 그 업무항목에서 이미 쓴 `구분` 값 (화면의 자동완성용 · 중복 제거) */
export async function noteLabels(groupId) {
    const db = (await load());
    const ids = new Set(withDescendants(aliveItems(db), groupId).map((i) => i.id));
    const labels = db.checklistNotes
        .filter((n) => ids.has(n.item_id) && n.label)
        .map((n) => n.label);
    return [...new Set(labels)].sort((a, b) => a.localeCompare(b, 'ko'));
}

/**
 * 주기의 기간 시작일 🔑 (독립 체크항목의 「기간당 1회」 판정은 이 함수 한 곳에만 둔다)
 *   daily/adhoc : 그 날짜 그대로 (하루가 곧 한 기간)
 *   weekly      : 그 날짜가 속한 주의 **월요일** (ISO 주 - 일요일은 그 전주 월요일로 간다)
 *   monthly     : 그 날짜가 속한 달의 1일
 * @param {string} cycle CHECK_CYCLE 값
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
export function periodStart(cycle, dateStr) {
    const day = String(dateStr || today()).slice(0, 10);
    if (cycle === CHECK_CYCLE.WEEKLY) {
        const d = new Date(`${day}T00:00:00`);
        if (Number.isNaN(d.getTime())) return day;
        const diff = (d.getDay() + 6) % 7;   // 월요일까지 거슬러 올라갈 일수 (일=6, 월=0 …)
        d.setDate(d.getDate() - diff);
        return toDateStr(d);
    }
    if (cycle === CHECK_CYCLE.MONTHLY) return `${day.slice(0, 7)}-01`;
    return day;
}

/** 직전 기간의 시작일 - late(지난 기간 미체크) 판정용. daily=어제, weekly=지난주 월요일, monthly=지난달 1일 */
export function prevPeriodStart(cycle, dateStr) {
    const start = periodStart(cycle, dateStr);
    if (cycle === CHECK_CYCLE.WEEKLY) return addDays(start, -7);
    if (cycle === CHECK_CYCLE.MONTHLY) {
        const d = new Date(`${start}T00:00:00`);
        d.setMonth(d.getMonth() - 1);
        return toDateStr(d);
    }
    return addDays(start, -1);
}

/**
 * 그 날짜에 해야 하는 항목인지 🔑 (주기 판정은 이 함수 한 곳에만 둔다)
 *   daily   : 매일
 *   weekly  : 지정 요일과 같은 날
 *   monthly : 지정 일자와 같은 날. **말일 보정** - 31일 지정이면 그 달 말일에 나온다
 *   adhoc   : 날짜와 무관하게 항상
 */
function isDueOn(item, date) {
    if (item.cycle === CHECK_CYCLE.DAILY || item.cycle === CHECK_CYCLE.ADHOC) return true;
    const d = new Date(`${String(date).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return false;
    if (item.cycle === CHECK_CYCLE.WEEKLY) return d.getDay() === Number(item.weekday);
    if (item.cycle === CHECK_CYCLE.MONTHLY) {
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        return d.getDate() === Math.min(Number(item.monthday) || 1, last);
    }
    return false;
}

/** 그 날짜의 체크 기록 (항목별 1건) */
export async function listChecks(date) {
    return (await load()).checklistChecks.filter((c) => c.check_date === date);
}

/**
 * 체크 처리 - on 이면 체크 기록을 남기고, 아니면 체크를 해제한다.
 * 항목·기간당 1건이므로 이미 있으면 메모만 갱신한다. 날짜는 항목 주기의 **기간 시작일**로
 * 정규화한다(`periodStart`) - 같은 주·같은 달 안에서 어느 날 눌러도 같은 기록 1건을 본다.
 * 🔑 상황(situation) 노드에 쓰면 **발생 처리**다. 발생을 해제하면 그 상황 아래
 * 체크 기록도 같은 날짜 것은 함께 지운다 (끼어들었던 단계가 통째로 빠진다).
 * 상위 상황이 발생 처리되지 않은 항목은 체크할 수 없다.
 * 🔑 **주기(`isDueOn`) 밖 날짜에는 체크할 수 없다** - 주기 밖 기록이 들어가면
 * 지난 기간 미체크(`late`) 집계가 어긋난다. **독립 항목(부모 없음)은 이 가드를 받지 않는다** -
 * 일일체크리스트는 기간(오늘 속한 주·달) 안에서 노출하는 것으로 대신한다. 해제는 막지 않는다
 * (잘못 들어간 기록 정리).
 * 해제 시 메모가 남아 있으면 행을 지우지 않고 `checked_at`·`checked_by`만 비운다(메모까지 비면 삭제).
 */
export async function setCheck(itemId, date, on, memo, user) {
    const db = (await load());
    const alive = aliveItems(db);
    const byId = new Map(alive.map((i) => [i.id, i]));
    const item = byId.get(itemId);
    if (!item) throw new Error('체크리스트 항목을 찾을 수 없습니다.');

    const eff = effectiveAssignee(item, byId);
    if (!canCheckItem(user, { ...item, assignee_eff_id: eff.id, assignee_eff_subs: eff.subs })) {
        throw new Error('담당자(정·부) 본인 또는 체크리스트 관리자만 체크할 수 있습니다.');
    }

    const independent = !item.parent_id;
    const day = periodStart(item.cycle, date);
    const sits = situationAncestors(item, byId);
    const isOn = (id) => db.checklistChecks.some((c) => c.item_id === id && c.check_date === day);
    if (on && !independent && !isDueOn(item, day)) {
        throw new Error('그 날짜의 체크 대상이 아닙니다.');
    }
    if (on && sits.some((id) => !isOn(id))) {
        throw new Error('상위 상황을 먼저 발생 처리해야 체크할 수 있습니다.');
    }

    const at = db.checklistChecks
        .findIndex((c) => c.item_id === itemId && c.check_date === day);

    if (!on) {
        if (at >= 0) {
            const row = db.checklistChecks[at];
            if (memo !== undefined) row.memo = String(memo ?? '').trim();
            if (String(row.memo ?? '').trim()) {
                row.checked_at = null;
                row.checked_by = null;
                row.checked_by_name = '';
            } else {
                db.checklistChecks.splice(at, 1);
            }
        }
        if (item.kind === CHECK_KIND.SITUATION) {
            const under = new Set(withDescendants(alive, itemId).map((x) => x.id));
            db.checklistChecks = db.checklistChecks
                .filter((c) => !(under.has(c.item_id) && c.check_date === day));
        }
        await save(db);
        return null;
    }

    const text = String(memo ?? '').trim();
    if (at >= 0) {
        Object.assign(db.checklistChecks[at], {
            memo: text, checked_by: user.id, checked_by_name: user.name,
            checked_at: new Date().toISOString(),
        });
        await save(db);
        return db.checklistChecks[at];
    }
    const row = {
        id: uid('cc'),
        item_id: itemId,
        check_date: day,
        memo: text,
        checked_by: user.id,
        checked_by_name: user.name,
        checked_at: new Date().toISOString(),
    };
    db.checklistChecks.push(row);
    await save(db);
    return row;
}

/**
 * 체크는 안 하고 메모만 남기거나 고친다 - 체크 여부는 건드리지 않는다.
 * 이미 체크된 행이면 메모만 바뀐다. 없던 행이면 `checked_at` 이 비어 있는 메모 전용 행을 만든다.
 */
export async function setCheckMemo(itemId, date, memo, user) {
    const db = (await load());
    const alive = aliveItems(db);
    const byId = new Map(alive.map((i) => [i.id, i]));
    const item = byId.get(itemId);
    if (!item) throw new Error('체크리스트 항목을 찾을 수 없습니다.');

    const eff = effectiveAssignee(item, byId);
    if (!canCheckItem(user, { ...item, assignee_eff_id: eff.id, assignee_eff_subs: eff.subs })) {
        throw new Error('담당자(정·부) 본인 또는 체크리스트 관리자만 메모를 남길 수 있습니다.');
    }

    const day = periodStart(item.cycle, date);
    const text = String(memo ?? '').trim();
    const at = db.checklistChecks.findIndex((c) => c.item_id === itemId && c.check_date === day);
    if (at >= 0) {
        db.checklistChecks[at].memo = text;
        if (!text && !db.checklistChecks[at].checked_at) db.checklistChecks.splice(at, 1);
        await save(db);
        return db.checklistChecks[at] ?? null;
    }
    if (!text) return null;
    const row = {
        id: uid('cc'),
        item_id: itemId,
        check_date: day,
        memo: text,
        checked_by: null,
        checked_by_name: '',
        checked_at: null,
    };
    db.checklistChecks.push(row);
    await save(db);
    return row;
}

/** 독립 체크항목(parent_id 없는 kind='check')이 쓰는 구분값 목록 - 빈 값 제외, 가나다순 */
export async function checklistCategories() {
    const db = await load();
    const cats = aliveItems(db)
        .filter((i) => i.kind === CHECK_KIND.CHECK && !i.parent_id && i.active)
        .map((i) => String(i.category ?? '').trim())
        .filter(Boolean);
    return [...new Set(cats)].sort((a, b) => a.localeCompare(b, 'ko'));
}

/**
 * 일일체크리스트 보드 🔑 - 독립 체크항목(트리가 아니라 parent_id 없는 kind='check')을 주기별로
 * 묶은 데이터. 🔑 독립 항목은 `daily` 플래그를 쓰지 않는다 - 보드는 `active` 만 본다
 * (그래서 등록 폼도 독립 체크항목에는 「일일체크리스트 포함」 체크박스를 내지 않는다).
 * 트리 판정(`isDueOn`)은 쓰지 않는다 - 노출 규칙이
 * 아예 다르다(그 날짜에만 나오는 것이 아니라 **기간 전체에 걸쳐** 나온다).
 * @param {string} dateStr YYYY-MM-DD - 그 날짜가 속한 기간(주·달)을 본다
 * @param {{assignee?:string, user?:object}} [f]
 *   assignee - manageChecklist 권한자가 특정 담당자로 좁혀 볼 때만 쓴다
 *   user     - 로그인 사용자. manageChecklist 권한이 없으면 본인 담당(정·부) + 담당 없는 항목만 준다
 * @returns {Promise<{daily:Array, weekly:Array, monthly:Array}>}
 */
export async function checklistBoard(dateStr, f = {}) {
    const db = await load();
    const day = String(dateStr || today()).slice(0, 10);
    const alive = aliveItems(db);
    const byId = new Map(alive.map((i) => [i.id, i]));
    const targets = alive.filter((i) => i.kind === CHECK_KIND.CHECK && !i.parent_id && i.active
        && i.cycle !== CHECK_CYCLE.ADHOC);   // 보드는 일/주/월만 - 수시 독립 항목은 다른 화면 몫이다

    const canSeeAll = !!f.user && canManageChecklist(f.user);
    const mine = f.user?.id ?? null;

    const board = { daily: [], weekly: [], monthly: [] };
    targets.forEach((item) => {
        const eff = effectiveAssignee(item, byId);
        if (canSeeAll) {
            const other = eff.id !== f.assignee && !eff.subs.some((s) => s.id === f.assignee);
            if (f.assignee && other) return;
        } else {
            const hasAssignee = !!eff.id || eff.subs.length > 0;
            if (hasAssignee && eff.id !== mine && !eff.subs.some((s) => s.id === mine)) return;
        }

        const period = periodStart(item.cycle, day);
        const row = db.checklistChecks
            .find((c) => c.item_id === item.id && c.check_date === period);
        // 지난 기간 미체크 - 🔑 그 기간이 시작된 뒤에 만든 항목은 애초에 체크할 수 없었으므로 뺀다
        // (안 그러면 방금 등록한 항목이 바로 「지난 기간 미체크」로 뜬다)
        const prevPeriod = prevPeriodStart(item.cycle, day);
        const born = String(item.created_at ?? '').slice(0, 10);
        const late = (!born || born <= prevPeriod) && !db.checklistChecks
            .some((c) => c.item_id === item.id && c.check_date === prevPeriod && c.checked_at);

        const bucket = item.cycle === CHECK_CYCLE.WEEKLY ? 'weekly'
            : item.cycle === CHECK_CYCLE.MONTHLY ? 'monthly' : 'daily';
        board[bucket].push({
            item,
            category: item.category || '',
            title: item.title,
            cycle: item.cycle,
            description: item.description || '',
            assignee_eff_id: eff.id,
            assignee_eff_name: eff.name,
            assignee_eff_subs: eff.subs,
            check: row ? {
                checked_at: row.checked_at,
                checked_by_name: row.checked_by_name,
                memo: row.memo,
            } : null,
            late,
            period,
        });
    });
    return board;
}

/* --------------------------------- 실시간 구독 -------------------------------- */

/**
 * 데이터 변경 구독.
 *   mock     : 다른 탭의 localStorage 변경 + 주기적 폴링
 *   supabase : Realtime 채널 (끊김 대비 폴링 병행)
 * **화면 코드는 어느 쪽인지 알 필요가 없다.**
 */
export function subscribe(callback, intervalMs = 5000) {
    return subscribeStore(callback, intervalMs);
}

/* ------------------------------ 모바일 조회 조합 ------------------------------ */

/**
 * 출고적치 대상 목록 (모바일 앱 `#/stow`).
 * 검수작업이 끝났고 아직 상차하지 않은 주문을 **상차 묶음 단위로 대표 1건만** 돌려준다.
 * 새 업무 규칙이 아니라 기존 조회(groupOf · stowStatus)를 조합한 것이다.
 *
 * @param {{createdBy?:string, keyword?:string}} f
 *   createdBy - viewAll 권한이 없는 사용자가 본인 등록건만 볼 때 쓴다
 */
export async function listStowTargets(f = {}) {
    const db = (await load());
    const rows = db.orders.filter((o) => !o.canceled_at && o.inspect_done_at && !loadDone(o))
        .filter((o) => !f.createdBy || o.created_by === f.createdBy);

    const byKey = new Map();
    rows.forEach((o) => {
        const key = groupKeyOf(o);
        const cur = byKey.get(key);
        if (!cur || compareHead(o, cur) < 0) byKey.set(key, o);
    });

    const list = [...byKey.values()].map((head) => {
        const g = groupOf(db, head.id);
        const total = g.pallets.length;
        const done = g.pallets.filter((p) => p.location).length;
        return {
            ...head,
            group_no: head.rep_no || head.order_no,
            group_nos: g.rows.map((r) => r.order_no),
            group_count: g.rows.length,
            group_pallets: total,
            group_stowed: done,
            stow_status: stowStatus(done, total),
        };
    });

    const k = String(f.keyword ?? '').trim().toLowerCase();
    const hit = (o) => [o.group_no, o.customer].concat(o.group_nos)
        .join(' ').toLowerCase().includes(k);
    return (k ? list.filter(hit) : list)
        .sort((a, b) => (a.group_no > b.group_no ? 1 : -1));
}

/**
 * 출고적치 진행 상황 (모바일 앱).
 * 적치·상차는 **묶음 단위**로 보므로 getLoadGroup 과 같은 범위로 센다.
 *
 * @returns {{done:number, total:number, left:number, status:string, stowed:boolean}|null}
 */
export async function stowProgress(orderId) {
    const g = groupOf((await load()), orderId);
    if (!g) return null;
    const total = g.pallets.length;
    const done = g.pallets.filter((p) => p.location).length;
    // 혼적(0 파렛트) 멤버는 검수완료 때 이미 적치완료로 찍힌다 - 파렛트를 가진 주문만 본다
    const holders = g.rows.filter((r) => g.pallets.some((p) => p.order_id === r.id));
    const rows = holders.length ? holders : g.rows;
    return {
        done,
        total,
        left: total - done,
        status: stowStatus(done, total),
        stowed: rows.every((r) => Boolean(r.stow_done_at)),
    };
}

/**
 * 상차대기 묶음 목록 (모바일 앱 `#/wait` · `#/stock`).
 * 적치가 끝났고 아직 상차되지 않은 주문을 **상차 묶음 단위**로 돌려준다.
 *
 * 🔑 **대상 주문(live)만으로 묶는다.** `groupOf` 로 묶음을 다시 펼치면 아직 적치 전이거나
 * 조회 범위 밖인 멤버까지 딸려 들어와, 대기 목록이 아닌 주문이 대표가 되고 파렛트 수가
 * 어긋난다. 웹 출고주문처리의 상차대기 탭도 같은 순서다 (행을 먼저 거르고 `loadGroups`).
 *
 * @param {{createdBy?:string}} f createdBy - 본인 등록건만 본다 (viewAll 권한 없음)
 * @returns {Promise<Array<object>>} getLoadGroup 과 같은 모양 `{head, rows, pallets}` 배열
 */
export async function listStowWaiting(f = {}) {
    const db = (await load());
    // 상차완료된 건만 뺀다. 상차 정보가 어긋난 건은 남겨 눈에 띄게 한다 (웹 상차대기 탭과 같다)
    const live = db.orders
        .filter((o) => o.stow_done_at && !loadDone(o) && !o.canceled_at)
        .filter((o) => !f.createdBy || o.created_by === f.createdBy);
    const optOf = stepOptOf(db);
    return loadGroups(live)
        .map((g) => {
            // 상차리스트와 같은 판정이다 - 화면끼리 같은 묶음이 다르게 보이지 않게 한다
            const reason = notReadyReason(g.rows, optOf);
            return {
                head: g.head,
                rows: g.rows,
                pallets: palletsOf(db, g.rows),
                blocked: Boolean(reason),
                block_reason: reason,
            };
        });
}
