/**
 * 데이터 접근 계층.
 * 화면 코드는 이 모듈의 함수만 사용하고, 내부 저장소(mock/Supabase)는 알지 못한다.
 * Supabase 구축 후에는 supabase-adapter.js 를 채우고 config.DATA_SOURCE 만 바꾸면 된다.
 */
import {
    COMPANY, DATA_SOURCE, EXTRA_TASK_TYPE, LOAD_STATUS, RESTORE_TYPE, WORK_STEPS,
    LOCATION_FORMAT, formatLocation, isValidLocation,
} from './config.js';
import { readyToLoad } from './steps.js';
import { SEED_USERS, SEED_ORDERS, SEED_ISSUES, makePallets } from './mock-data.js';
import { uid, today } from './util.js';

const KEY = 'tpl_order_db_v1';

/**
 * 기능이 추가되면서 생긴 새 필드를 기존 저장 데이터에 채워 넣는다.
 * (이전 버전에서 저장된 데이터를 그대로 열어도 오류가 나지 않게 한다)
 */
function normalize(db) {
    db.restores = db.restores ?? [];
    // 소속 명칭 변경 (더퓨어랩 → 고객사, 용마물류 → 용마로지스)
    const RENAMED = { 더퓨어랩: COMPANY.CUSTOMER, 용마물류: COMPANY.LOGISTICS };
    db.users.forEach((u) => {
        u.company = RENAMED[u.company] ?? u.company;
    });
    db.orders.forEach((o) => {
        o.extra_works = o.extra_works ?? [];
        o.edit_count = o.edit_count ?? 0;
        o.confirmed_at = o.confirmed_at ?? null;
        o.canceled_at = o.canceled_at ?? null;
        // 단계별 완료 시각 (없으면 미완료)
        WORK_STEPS.forEach((step) => {
            o[step.at] = o[step.at] ?? null;
        });
        o.ship_started_at = o.ship_started_at ?? null;
        o.packing_at = o.packing_at ?? null;
        // 검수완료 시 입력하는 실측값
        o.box_count = o.box_count ?? 0;
        // 상차까지 끝난 뒤 용마담당자가 찍는 최종 완료처리
        o.closed_at = o.closed_at ?? null;
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

/** localStorage 에서 전체 데이터를 읽는다. 없으면 시드 데이터로 초기화한다. */
function load() {
    const raw = localStorage.getItem(KEY);
    if (raw) {
        try {
            return normalize(JSON.parse(raw));
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

function save(db) {
    localStorage.setItem(KEY, JSON.stringify(db));
}

/** 저장 데이터를 시드 상태로 되돌린다 */
export function resetDb() {
    localStorage.removeItem(KEY);
    load();
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
    return load().users;
}

export async function getUser(id) {
    return load().users.find((u) => u.id === id) ?? null;
}

/** 사용자 권한 변경 (관리자 전용 화면에서 호출) */
export async function updateUserRole(id, role) {
    const db = load();
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('사용자를 찾을 수 없습니다.');
    u.role = role;
    save(db);
    return u;
}

/** 사용자 소속 변경 (주문정보등록 화면의 권한이 소속에 따라 달라진다) */
export async function updateUserCompany(id, company) {
    const db = load();
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('사용자를 찾을 수 없습니다.');
    u.company = company;
    save(db);
    return u;
}

/** 사용자 사용여부 토글 */
export async function toggleUserActive(id) {
    const db = load();
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('사용자를 찾을 수 없습니다.');
    u.active = !u.active;
    save(db);
    return u;
}

export async function createUser(payload) {
    const db = load();
    const row = { id: uid('u'), active: true, ...payload };
    db.users.push(row);
    save(db);
    return row;
}

/* ----------------------------------- 주문 ----------------------------------- */

/**
 * 주문 목록 조회
 * @param {{from?:string, to?:string, keyword?:string, createdBy?:string,
 *          shipDate?:string, minStage?:number}} f 필터
 */
export async function listOrders(f = {}) {
    const db = load();
    let rows = [...db.orders];
    if (f.createdBy) rows = rows.filter((o) => o.created_by === f.createdBy);
    if (f.from) rows = rows.filter((o) => o.reg_date >= f.from);
    if (f.to) rows = rows.filter((o) => o.reg_date <= f.to);
    if (f.shipDate) rows = rows.filter((o) => o.ship_req_date === f.shipDate);
    if (f.keyword) {
        const k = f.keyword.trim().toLowerCase();
        rows = rows.filter((o) => `${o.order_no} ${o.customer}`.toLowerCase().includes(k));
    }
    rows.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    return rows;
}

export async function getOrder(id) {
    return load().orders.find((o) => o.id === id) ?? null;
}

/**
 * 주문 등록.
 * 동일 주문번호가 이미 존재하면 차수를 자동으로 +1 한다.
 */
export async function createOrder(payload, user) {
    const db = load();
    const same = db.orders.filter((o) => o.order_no === payload.order_no);
    const seq = same.length ? Math.max(...same.map((o) => o.seq)) + 1 : 1;
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
        ...payload,
    };
    db.orders.push(row);
    db.pallets.push(...makePallets(row));
    addHistory(db, row.id, '등록', '', `${row.order_no} (${seq}차수)`, user);
    save(db);
    return row;
}

/** 주문 변동사항 수정 - 변경된 항목마다 히스토리를 남긴다 */
export async function updateOrder(id, patch, user, memo = '') {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    const labels = {
        send_date: '전송일자', order_no: '주문번호', customer: '거래처명',
        ship_req_date: '출고요청일', vehicle_type: '차량구분',
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
    save(db);
    return o;
}

export async function deleteOrder(id, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) return;
    db.orders = db.orders.filter((x) => x.id !== id);
    db.pallets = db.pallets.filter((p) => p.order_id !== id);
    addHistory(db, id, '삭제', o.order_no, '', user);
    save(db);
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
    const db = load();
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return null;
    if (o[STEP_DONE_FIELD[step]]) return o;   // 완료된 단계는 그대로 둔다
    if (o[field] === user.name) return o;
    o[field] = user.name;
    save(db);
    return o;
}

/** 작업자가 비어 있으면 처리한 사람 이름으로 채운다 (스캔 없이 처리된 경우 대비) */
function fillWorker(o, step, user) {
    const field = WORKER_FIELD[step];
    if (field && !o[field]) o[field] = user?.name ?? '';
}

/** 주문번호로 주문을 찾는다 (취소된 건은 제외, 차수 오름차순) */
export async function findOrdersByNo(orderNo) {
    const key = String(orderNo).trim().toUpperCase();
    if (!key) return [];
    return load().orders
        .filter((o) => o.order_no.toUpperCase() === key && !o.canceled_at)
        .sort((a, b) => a.seq - b.seq);
}

/** 단계 완료 시각을 설정하거나 지우고 이력에 남긴다 */
function setStepAt(db, o, field, label, done, user, memo = '') {
    o[field] = done ? new Date().toISOString() : null;
    addHistory(db, o.id, label, done ? '' : '완료', done ? '완료' : '취소', user, memo);
}

/** 출고작업 시작 */
export async function startShipWork(id, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (o.ship_done_at) throw new Error('이미 출고작업이 완료된 주문입니다.');
    o.ship_started_at = new Date().toISOString();
    fillWorker(o, 'ship', user);
    addHistory(db, id, '출고작업', '', '작업시작', user);
    save(db);
    return o;
}

/** 출고작업 완료 / 완료 취소 */
export async function setShipWorkDone(id, done, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && o.inspect_done_at) {
        throw new Error('검수작업이 완료된 주문입니다. 검수를 먼저 취소하세요.');
    }
    if (!done && o.inspect_done_at) {
        throw new Error('검수작업이 완료된 주문은 출고작업을 취소할 수 없습니다.');
    }
    if (done && !o.ship_started_at) o.ship_started_at = new Date().toISOString();
    if (done) fillWorker(o, 'ship', user);
    setStepAt(db, o, 'ship_done_at', '출고작업', done, user);
    if (!done) o.ship_started_at = null;
    save(db);
    return o;
}

/**
 * 검수작업 완료 / 완료 취소
 * 검수는 시작 개념 없이 완료만 처리한다.
 * @param {{reqWork:boolean, packing:boolean}} checks 요청작업·패킹리스트 확인 여부
 */
export async function setInspectDone(id, done, checks, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !o.ship_done_at) throw new Error('출고작업이 완료된 주문만 검수할 수 있습니다.');
    if (!done && o.loaded_at) throw new Error('상차완료된 주문은 검수를 취소할 수 없습니다.');

    const hasExtra = (o.extra_works ?? []).length > 0;
    if (done && hasExtra && !checks.reqWork) {
        throw new Error('요청작업 확인을 체크해야 검수를 완료할 수 있습니다.');
    }
    if (done && !checks.packing) {
        throw new Error('패킹리스트 작성 확인을 체크해야 검수를 완료할 수 있습니다.');
    }

    // 검수 실측값 - 총 파렛트수와 총 박스수를 입력해야 완료할 수 있다
    if (done) {
        const pallet = Number(checks.palletCount);
        const box = Number(checks.boxCount);
        if (!Number.isInteger(pallet) || pallet < 1) {
            throw new Error('총 파렛트수를 1 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.');
        }
        if (!Number.isInteger(box) || box < 1) {
            throw new Error('총 박스수를 1 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.');
        }
        // 파렛트 수가 바뀌면 상차 검수 바코드를 그 수만큼 다시 만든다
        const changed = o.pallet_count !== pallet;
        o.pallet_count = pallet;
        o.box_count = box;
        if (changed || !db.pallets.some((x) => x.order_id === o.id)) rebuildPallets(db, o);
    }

    if (done) fillWorker(o, 'inspect', user);
    if (hasExtra) setStepAt(db, o, 'req_work_at', '요청작업', done, user);
    o.packing_at = done ? new Date().toISOString() : null;
    setStepAt(db, o, 'inspect_done_at', '검수작업', done, user);
    save(db);
    return o;
}

/** 추가작업 완료 / 완료 취소 */
export async function setExtraWorkDone(id, done, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !o.inspect_done_at) {
        throw new Error('검수작업이 완료된 주문만 추가작업을 처리할 수 있습니다.');
    }
    if (!done && o.loaded_at) throw new Error('상차완료된 주문은 추가작업을 취소할 수 없습니다.');
    if (done) fillWorker(o, 'extra', user);
    setStepAt(db, o, 'extra_done_at', '추가작업', done, user);
    save(db);
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
    const db = load();
    const byNo = {};
    db.orders.forEach((o) => {
        (byNo[o.order_no] ??= []).push(o);
    });
    const rows = [];

    db.issues
        .filter((i) => i.type === EXTRA_TASK_TYPE && i.order_no)
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

/**
 * 추가작업 요청 목록.
 * 이슈등록의 '작업요청' 유형 건을 주문번호로 이어 붙인다.
 * @returns {Array} 요청 + 연결된 주문 정보
 */
export async function listExtraTasks() {
    const db = load();
    const byNo = {};
    db.orders.forEach((o) => {
        (byNo[o.order_no] ??= []).push(o);
    });
    return db.issues
        .filter((i) => i.type === EXTRA_TASK_TYPE && i.order_no)
        .map((i) => ({ issue: i, orders: byNo[i.order_no.trim()] ?? [] }))
        .sort((a, b) => (b.issue.created_at > a.issue.created_at ? 1 : -1));
}

/** 추가작업 요청이 있는 주문번호 집합 */
function extraTaskNoSet(db) {
    return new Set(
        db.issues
            .filter((i) => i.type === EXTRA_TASK_TYPE && i.order_no)
            .map((i) => i.order_no.trim()),
    );
}

/** 주문번호별 추가작업 요청 여부 { 주문번호: true } */
export async function extraTaskMap() {
    const set = extraTaskNoSet(load());
    return Object.fromEntries([...set].map((no) => [no, true]));
}

/**
 * 주문 접수확인 토글.
 * 물류 담당자가 주문 내용을 확인했음을 표시한다. 체크를 해제할 수도 있다.
 */
export async function toggleOrderConfirm(id, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.confirmed_at) {
        o.confirmed_at = null;
        o.confirmed_by = null;
        o.confirmed_by_name = '';
        addHistory(db, id, '접수확인', '접수확인', '미확인', user);
    } else {
        o.confirmed_at = new Date().toISOString();
        o.confirmed_by = user.id;
        o.confirmed_by_name = user.name;
        addHistory(db, id, '접수확인', '미확인', '접수확인', user);
    }
    save(db);
    return o;
}

/**
 * 주문 취소 처리.
 * 취소하면 수정·조정요청을 할 수 없고 진행상태가 '취소' 로 바뀐다.
 */
export async function cancelOrder(id, user, reason = '') {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('이미 취소된 주문입니다.');
    o.canceled_at = new Date().toISOString();
    o.canceled_by = user.id;
    o.canceled_by_name = user.name;
    addHistory(db, id, '취소', '', '취소 처리', user, reason);
    save(db);
    return o;
}

/**
 * 주문별 확인 현황 요약.
 * 확인 컬럼의 체크박스 상태와 이력 버튼 색상을 정하는 데 쓴다.
 * @returns {{[orderId:string]: {edits:number, editsLeft:number,
 *            restores:number, restoresLeft:number}}}
 */
export async function checkStats() {
    const db = load();
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
 * 확인 상태를 일괄로 바꾼다.
 * ⚠️ 확인 처리할 때는 **아직 확인되지 않은 건만** 대상으로 한다.
 *    이미 확인된 건까지 다시 쓰면 먼저 확인한 사람과 시각이 지워진다.
 * @returns {number} 실제로 바뀐 건수
 */
function applyChecked(rows, checked, user) {
    const targets = rows.filter((r) => (checked ? !r.checked_at : Boolean(r.checked_at)));
    const now = new Date().toISOString();
    targets.forEach((r) => {
        r.checked_at = checked ? now : null;
        r.checked_by = checked ? user.id : null;
        r.checked_by_name = checked ? user.name : '';
    });
    return targets.length;
}

/**
 * 주문의 수정 이력을 일괄 확인 처리하거나 해제한다.
 * 확인 시에는 새로 등록된(아직 미확인인) 수정만 처리한다.
 */
export async function setAllHistoryChecked(orderId, checked, user) {
    const db = load();
    const rows = db.history.filter((h) => h.order_id === orderId && h.rev > 0);
    const count = applyChecked(rows, checked, user);
    save(db);
    return count;
}

/**
 * 주문의 조정요청을 일괄 확인 처리하거나 해제한다.
 * 확인 시에는 새로 등록된(아직 미확인인) 요청만 처리한다.
 */
export async function setAllRestoresChecked(orderId, checked, user) {
    const db = load();
    const rows = db.restores.filter((r) => r.order_id === orderId);
    const count = applyChecked(rows, checked, user);
    save(db);
    return count;
}

/**
 * 변동 이력 1건의 수정확인 상태를 토글한다.
 * 담당자가 변경 내용을 확인했는지 표시하는 용도이며, 잘못 누르면 다시 눌러 해제한다.
 */
export async function toggleHistoryCheck(historyId, user) {
    const db = load();
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
    save(db);
    return h;
}

/** 주문별 변동사항 히스토리 */
export async function listHistory(orderId) {
    return load().history
        .filter((h) => h.order_id === orderId)
        .sort((a, b) => (b.changed_at > a.changed_at ? 1 : -1));
}

/* --------------------------------- 조정요청 --------------------------------- */

/**
 * 조정요청 목록 조회
 * @param {string} [orderId] 주어지면 해당 주문의 요청만 반환
 */
export async function listRestores(orderId) {
    const rows = load().restores;
    const filtered = orderId ? rows.filter((r) => r.order_id === orderId) : rows;
    return [...filtered].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

/**
 * 조정요청 1건의 확인 상태를 토글한다.
 * 변동 이력의 수정확인과 동작 방식이 같다.
 */
export async function toggleRestoreCheck(restoreId, user) {
    const db = load();
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
    save(db);
    return r;
}

/**
 * 주문별 조정요청 현황 { 주문ID: { has, done } }.
 * done 은 등록된 조정요청이 모두 확인 처리되었는지를 뜻하며,
 * 주문처리현황의 '조정작업' 단계 완료 판단에 쓴다.
 */
export async function adjustMap() {
    const map = {};
    load().restores.forEach((r) => {
        const m = (map[r.order_id] ??= { has: true, done: true });
        if (!r.checked_at) m.done = false;
    });
    return map;
}

/** 주문별 조정요청 건수를 { 주문ID: 건수 } 형태로 반환한다 */
export async function countRestores() {
    const map = {};
    load().restores.forEach((r) => {
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
    const db = load();
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
    save(db);
    return row;
}

/* -------------------------------- 상차 / 검수 -------------------------------- */

/**
 * 당일상차리스트 조회.
 * 상차 이외의 모든 작업(패킹리스트까지)이 완료된 주문만 대상으로 한다.
 */
export async function listLoading(shipDate) {
    const db = load();
    const tasks = extraTaskNoSet(db);
    const adjust = {};
    db.restores.forEach((r) => {
        const m = (adjust[r.order_id] ??= { has: true, done: true });
        if (!r.checked_at) m.done = false;
    });
    return db.orders
        .filter((o) => o.ship_req_date === shipDate
            && !o.canceled_at
            && readyToLoad(o, { task: tasks.has(o.order_no), adjust: adjust[o.id] }))
        .sort((a, b) => (a.order_no > b.order_no ? 1 : -1));
}

export async function listPallets(orderId) {
    return load().pallets.filter((p) => p.order_id === orderId);
}

/**
 * 파렛트 바코드 스캔 처리
 * @returns {{ok:boolean, msg:string, order?:object}}
 */
/**
 * 출고적치 - 파렛트 1개의 로케이션을 기록한다.
 * 검수작업이 끝난 주문만 적치할 수 있고, 전량 입력되면 `stow_done_at` 이 자동으로 채워진다.
 */
export async function setPalletLocation(palletId, location) {
    const db = load();
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
    save(db);
    return o;
}

/** 로케이션 지우기 (잘못 입력한 경우) */
export async function clearPalletLocation(palletId) {
    const db = load();
    const p = db.pallets.find((x) => x.id === palletId);
    if (!p) throw new Error('파렛트를 찾을 수 없습니다.');
    const o = db.orders.find((x) => x.id === p.order_id);
    if (o?.loaded_at) throw new Error('상차완료된 주문은 적치를 되돌릴 수 없습니다.');
    p.location = '';
    if (o) syncStowDone(db, o);
    save(db);
    return o;
}

/** 파렛트 전량에 로케이션이 있으면 출고적치 완료로 본다 */
function syncStowDone(db, o) {
    const mine = db.pallets.filter((p) => p.order_id === o.id);
    const all = mine.length > 0 && mine.every((p) => p.location);
    if (all && !o.stow_done_at) o.stow_done_at = new Date().toISOString();
    if (!all && o.stow_done_at) o.stow_done_at = null;
}

/**
 * 상차 준비 - 적치된 파렛트를 하나씩 내린다 (당일상차리스트의 로케이션 팝업).
 * 상차완료된 주문은 더 이상 바꾸지 않는다.
 */
export async function setPalletPicked(palletId, done) {
    const db = load();
    const p = db.pallets.find((x) => x.id === palletId);
    if (!p) throw new Error('파렛트를 찾을 수 없습니다.');
    const o = db.orders.find((x) => x.id === p.order_id);
    if (o?.loaded_at) throw new Error('상차완료된 주문은 변경할 수 없습니다.');
    if (done && !p.location) throw new Error('적치 로케이션이 없는 파렛트입니다.');
    p.picked_at = done ? new Date().toISOString() : null;
    save(db);
    return p;
}

/** 주문별 적치 진행 수 { done, total } */
export async function stowCount(orderId) {
    const mine = load().pallets.filter((p) => p.order_id === orderId);
    return { done: mine.filter((p) => p.location).length, total: mine.length };
}

export async function scanPallet(orderId, barcode, user) {
    const db = load();
    const code = String(barcode).trim().toUpperCase();
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return { ok: false, msg: '주문을 찾을 수 없습니다.' };

    const mine = db.pallets.filter((p) => p.order_id === orderId);
    if (!mine.length) {
        return {
            ok: false,
            msg: '검수할 파렛트가 없습니다. 출고주문처리 검수작업에서 파렛트수를 입력하세요.',
        };
    }

    // 상차라벨의 바코드는 주문번호다. 파렛트마다 같은 라벨이 붙으므로
    // 주문번호를 스캔할 때마다 아직 검수되지 않은 파렛트를 하나씩 채운다.
    // (예전 방식인 파렛트 개별 바코드 {주문번호}-P01 도 그대로 인식한다)
    const isOrderCode = code === String(o.order_no).trim().toUpperCase();
    const target = isOrderCode
        ? mine.find((p) => !p.scanned_at)
        : mine.find((p) => p.barcode.toUpperCase() === code);

    if (!target) {
        return isOrderCode
            ? { ok: false, msg: `이미 전량 검수되었습니다. (${mine.length}/${mine.length})` }
            : { ok: false, msg: '해당 주문의 바코드가 아닙니다.' };
    }
    if (target.scanned_at) return { ok: false, msg: '이미 검수된 파렛트입니다.' };

    target.scanned_at = new Date().toISOString();
    o.inspected = db.pallets.filter((p) => p.order_id === orderId && p.scanned_at).length;
    if (o.inspected >= o.pallet_count && o.load_status === LOAD_STATUS.WAIT) {
        o.load_status = LOAD_STATUS.INSPECTED;
        addHistory(db, orderId, '검수', '대기', '검수완료', user);
    }
    save(db);
    return { ok: true, msg: `검수 완료 (${o.inspected}/${o.pallet_count})`, order: o };
}

/** 검수 취소 (전체 초기화) */
export async function resetInspection(orderId, user) {
    const db = load();
    db.pallets.filter((p) => p.order_id === orderId).forEach((p) => { p.scanned_at = null; });
    const o = db.orders.find((x) => x.id === orderId);
    o.inspected = 0;
    o.load_status = LOAD_STATUS.WAIT;
    addHistory(db, orderId, '검수', '검수완료', '대기', user);
    save(db);
    return o;
}

/** 상차완료 처리 */
export async function completeLoading(orderId, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.load_status !== LOAD_STATUS.INSPECTED) {
        throw new Error('검수가 완료된 건만 상차완료 처리할 수 있습니다.');
    }
    o.load_status = LOAD_STATUS.DONE;
    o.loaded_at = new Date().toISOString();
    addHistory(db, orderId, '상차작업', '', '완료', user);
    save(db);
    return o;
}

/**
 * 출고 완료처리 / 완료처리 취소.
 * 상차작업까지 끝난 주문을 용마담당자가 최종 마감하는 단계다.
 * 완료처리된 주문은 주문처리현황의 `현재진행` 탭에서 빠지고 `출고완료` 탭으로 간다.
 */
export async function closeOrder(id, done, user) {
    const db = load();
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !o.loaded_at) {
        throw new Error('상차작업까지 완료된 주문만 완료처리할 수 있습니다.');
    }
    o.closed_at = done ? new Date().toISOString() : null;
    addHistory(db, id, '출고완료', done ? '진행' : '완료', done ? '완료' : '진행', user);
    save(db);
    return o;
}

/** 전체 조정요청 (상세검색에서 본문을 훑을 때 쓴다) */
export async function listAllRestores() {
    return [...load().restores];
}

/* ----------------------------------- 이슈 ----------------------------------- */

export async function listIssues(f = {}) {
    const db = load();
    let rows = [...db.issues];
    if (f.createdBy) rows = rows.filter((i) => i.created_by === f.createdBy);
    if (f.status) rows = rows.filter((i) => i.status === f.status);
    if (f.keyword) {
        const k = f.keyword.trim().toLowerCase();
        rows = rows.filter((i) => `${i.title} ${i.order_no}`.toLowerCase().includes(k));
    }
    rows.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    return rows;
}

export async function createIssue(payload, user) {
    const db = load();
    const row = {
        id: uid('i'),
        created_at: new Date().toISOString(),
        status: '접수',
        created_by: user.id,
        ...payload,
    };
    db.issues.push(row);
    save(db);
    return row;
}

export async function updateIssue(id, patch) {
    const db = load();
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    Object.assign(i, patch);
    save(db);
    return i;
}

/* --------------------------------- 실시간 구독 -------------------------------- */

/**
 * 데이터 변경 구독.
 * mock 모드에서는 다른 탭의 localStorage 변경과 주기적 폴링으로 대체한다.
 * Supabase 전환 시 realtime 채널 구독으로 교체한다.
 */
export function subscribe(callback, intervalMs = 5000) {
    const onStorage = (e) => { if (e.key === KEY) callback(); };
    window.addEventListener('storage', onStorage);
    const timer = setInterval(callback, intervalMs);
    return () => {
        window.removeEventListener('storage', onStorage);
        clearInterval(timer);
    };
}

export const dataSource = DATA_SOURCE;
