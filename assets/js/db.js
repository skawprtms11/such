/**
 * 데이터 접근 계층.
 * 화면 코드는 이 모듈의 함수만 사용하고, 내부 저장소(mock/Supabase)는 알지 못한다.
 * Supabase 구축 후에는 supabase-adapter.js 를 채우고 config.DATA_SOURCE 만 바꾸면 된다.
 */
import {
    COMPANY, EXTRA_TASK_TYPE, INITIAL_PASSWORD, ISSUE_STATE, LOAD_STATUS, PERMISSION,
    RESTORE_TYPE, ROLE, WORK_STEPS, YN, LOCATION_FORMAT, adjustCategory,
    formatLocation, isValidLocation,
} from './config.js';
import { readyToLoad, loadDone } from './steps.js';
import {
    loadDb, saveDb, resetDb as storeReset, subscribeStore, isSupabase, invalidate,
} from './store.js';
import { supabase } from './supabase.js';
import { uid, today, toDateStr } from './util.js';

/**
 * 기능이 추가되면서 생긴 새 필드를 기존 저장 데이터에 채워 넣는다.
 * (이전 버전에서 저장된 데이터를 그대로 열어도 오류가 나지 않게 한다)
 */
function normalize(db) {
    db.restores = db.restores ?? [];
    db.comments = db.comments ?? [];
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
        rows = rows.filter((o) => `${o.order_no} ${o.customer}`.toLowerCase().includes(k));
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
    const labels = {
        send_date: '전송일자', order_no: '주문번호', customer: '거래처명',
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

/** 주문번호로 주문을 찾는다 (취소된 건은 제외, 차수 오름차순) */
export async function findOrdersByNo(orderNo) {
    const key = String(orderNo).trim().toUpperCase();
    if (!key) return [];
    return (await load()).orders
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
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (!o.confirmed_at) {
        throw new Error('주문정보등록에서 접수 처리되지 않은 주문입니다. 접수 후 시작할 수 있습니다.');
    }
    if (o.ship_done_at) throw new Error('이미 출고작업이 완료된 주문입니다.');
    o.ship_started_at = new Date().toISOString();
    fillWorker(o, 'ship', user);
    addHistory(db, id, '출고작업', '', '작업시작', user);
    await save(db);
    return o;
}

/** 출고작업 완료 / 완료 취소 */
export async function setShipWorkDone(id, done, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !o.confirmed_at) {
        throw new Error('주문정보등록에서 접수 처리되지 않은 주문입니다. 접수 후 완료할 수 있습니다.');
    }
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
    await save(db);
    return o;
}

/**
 * 검수작업 완료 / 완료 취소
 * 검수는 시작 개념 없이 완료만 처리한다.
 * @param {{reqWork:boolean}} checks 요청작업 확인 여부와 검수 실측값
 */
export async function setInspectDone(id, done, checks, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !o.ship_done_at) throw new Error('출고작업이 완료된 주문만 검수할 수 있습니다.');
    if (!done && loadDone(o)) throw new Error('상차완료된 주문은 검수를 취소할 수 없습니다.');
    // 다시 완료 처리하면 파렛트수 변경으로 상차검수가 초기화되어(rebuildPallets)
    // loaded_at 만 남고 load_status 가 '대기' 로 어긋난다. 상차를 먼저 되돌려야 한다
    if (done && loadDone(o)) {
        throw new Error('상차완료된 주문입니다. 당일상차리스트에서 상차완료를 먼저 취소하세요.');
    }
    // 적치가 끝난 주문은 순서대로 되돌린다. 적치를 남긴 채 검수만 취소하면
    // '검수 미완료 · 적치 완료' 라는 앞뒤 안 맞는 상태가 되고, 적치를 고칠 수도 없다
    if (!done && o.pallet_count && o.stow_done_at) {
        throw new Error('출고적치가 완료된 주문입니다. 출고적치 탭에서 적치취소를 먼저 하세요.');
    }

    const hasExtra = o.extra_yn === YN.YES || (o.extra_works ?? []).length > 0;
    const hasPacking = o.packing_yn === YN.YES;
    if (done && hasExtra && !checks.reqWork) {
        throw new Error('요청작업 확인을 체크해야 검수를 완료할 수 있습니다.');
    }
    // 패킹리스트는 주문 등록 시 '있음' 인 경우에만 확인한다.
    // 별도 체크 없이 내용(packing_note)이 작성되어 있어야 완료로 본다
    if (done && hasPacking && !(o.packing_note ?? '').trim()) {
        throw new Error('패킹리스트를 먼저 작성해야 검수를 완료할 수 있습니다.');
    }

    // 검수 실측값 - 총 파렛트수와 총 박스수를 입력해야 완료할 수 있다
    if (done) {
        const pallet = Number(checks.palletCount);
        const box = Number(checks.boxCount);
        // 추가건(2차수 이상)은 기존 차수 파렛트에 혼적할 수 있어 0파렛트를 허용한다
        const minPallet = o.seq > 1 ? 0 : 1;
        if (!Number.isInteger(pallet) || pallet < minPallet) {
            throw new Error(o.seq > 1
                ? '총 파렛트수를 0 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.'
                : '총 파렛트수를 1 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.');
        }
        if (!Number.isInteger(box) || box < 1) {
            throw new Error('총 박스수를 1 이상의 숫자로 입력해야 검수를 완료할 수 있습니다.');
        }
        // 파렛트 수가 바뀌면 상차 검수 바코드를 그 수만큼 다시 만든다
        const changed = o.pallet_count !== pallet;
        o.pallet_count = pallet;
        o.box_count = box;
        if (changed || !db.pallets.some((x) => x.order_id === o.id)) rebuildPallets(db, o);
        // 혼적 추가건(0파렛트)은 적치할 파렛트가 없다. 출고적치 단계를 함께 끝낸다.
        o.stow_done_at = pallet === 0 ? new Date().toISOString() : o.stow_done_at;
    }

    if (!done && !o.pallet_count) o.stow_done_at = null;   // 혼적 건은 적치도 함께 되돌린다
    if (done) fillWorker(o, 'inspect', user);
    if (hasExtra) setStepAt(db, o, 'req_work_at', '요청작업', done, user);
    o.packing_at = done && hasPacking ? new Date().toISOString() : null;
    setStepAt(db, o, 'inspect_done_at', '검수작업', done, user);
    await save(db);
    return o;
}

/**
 * 패킹리스트 내용 작성/수정.
 * 패킹리스트가 '있음' 인 주문만 대상이다.
 * 주문정보등록 목록의 패킹리스트 컬럼과 모바일 검수작업 탭이 **같은 값**을 다룬다.
 * 어느 쪽에서 쓰든 내용(`packing_note`)은 하나이고, 저장하면 양쪽에 그대로 반영된다.
 */
export async function setPackingNote(id, note, user) {
    const text = String(note ?? '').trim();
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (loadDone(o)) throw new Error('상차완료된 주문은 패킹리스트를 고칠 수 없습니다.');
    if (o.packing_yn !== YN.YES) {
        throw new Error('패킹리스트가 있음인 주문만 작성할 수 있습니다.');
    }
    // 빈 내용은 저장하지 않는다. 검수완료(packing_at)된 주문의 내용이 지워지면
    // '패킹리스트 완료인데 내용 없음' 이라는 앞뒤 안 맞는 상태가 된다
    if (!text) throw new Error('패킹리스트 내용을 입력하세요.');
    if ((o.packing_note ?? '') !== text) {
        addHistory(db, id, '패킹리스트 내용', o.packing_note, text, user);
        o.packing_note = text;
        await save(db);
    }
    return o;
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
 */
export async function confirmOrder(id, workNote, user) {
    const note = String(workNote ?? '').trim();
    if (!note) throw new Error('작업지시를 작성해야 접수할 수 있습니다.');
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (o.confirmed_at) throw new Error('이미 접수된 주문입니다.');
    o.confirmed_at = new Date().toISOString();
    o.confirmed_by = user.id;
    o.confirmed_by_name = user.name;
    o.work_note = note;
    addHistory(db, id, '접수', '대기', `접수 · 작업지시: ${note}`, user);
    await save(db);
    return o;
}

/** 접수 취소 - 출고작업에 착수하기 전까지만 되돌릴 수 있다. 작업지시도 함께 초기화한다 */
export async function revokeOrderConfirm(id, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (!o.confirmed_at) throw new Error('접수되지 않은 주문입니다.');
    if (o.ship_started_at || o.ship_done_at) {
        throw new Error('출고작업에 착수한 주문은 접수를 취소할 수 없습니다.');
    }
    o.confirmed_at = null;
    o.confirmed_by = null;
    o.confirmed_by_name = '';
    o.work_note = '';
    addHistory(db, id, '접수', '접수', '접수취소 (작업지시 초기화)', user);
    await save(db);
    return o;
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
 * 당일상차리스트 조회.
 * 상차 이외의 모든 작업(패킹리스트까지)이 완료된 주문만 대상으로 한다.
 */
export async function listLoading(shipDate) {
    const db = (await load());
    const tasks = extraTaskNoSet(db);
    const adjust = {};
    db.restores.forEach((r) => {
        const m = (adjust[r.order_id] ??= { has: true, done: true });
        if (!r.checked_at) m.done = false;
    });
    const ready = db.orders
        .filter((o) => o.ship_req_date === shipDate
            && !o.canceled_at
            && readyToLoad(o, { task: tasks.has(o.order_no), adjust: adjust[o.id] }));

    // 추가주문은 1차수와 함께 배송되므로 주문번호별로 묶어 대표 1건만 보여준다
    const byNo = new Map();
    ready.forEach((o) => {
        const base = o.base_no ?? o.order_no;
        const cur = byNo.get(base);
        if (!cur || o.seq < cur.seq) byNo.set(base, o);
    });
    return [...byNo.values()]
        .map((head) => {
            const g = groupOf(db, head.id);
            return {
                ...head,
                group_count: g.rows.length,
                group_pallets: g.pallets.length,
                group_inspected: g.pallets.filter((p) => p.scanned_at).length,
            };
        })
        .sort((a, b) => (a.order_no > b.order_no ? 1 : -1));
}

/**
 * 같은 주문번호의 차수들을 묶은 상차 단위.
 * 추가주문은 1차수와 함께 한 거래처로 배송되므로 검수·상차를 묶어서 본다.
 *
 * @returns {{head:object, rows:object[], pallets:object[]}}
 *   head    - 대표(1차수) 주문
 *   rows    - 취소되지 않은 차수 전체 (차수 오름차순)
 *   pallets - 모든 차수의 파렛트 (차수 → 파렛트 번호 순, seq/label 이 붙는다)
 */
function groupOf(db, orderId) {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) return null;
    const rows = db.orders
        .filter((x) => (x.base_no ?? x.order_no) === (o.base_no ?? o.order_no) && !x.canceled_at)
        .sort((a, b) => a.seq - b.seq);
    const pallets = rows.flatMap((r) => db.pallets
        .filter((p) => p.order_id === r.id)
        .map((p, i) => ({
            ...p,
            seq: r.seq,
            label: `${r.order_no}-${String(i + 1).padStart(2, '0')}`,
        })));
    return { head: rows[0] ?? o, rows, pallets };
}

/** 상차 단위 조회 (화면용) */
export async function getLoadGroup(orderId) {
    return groupOf((await load()), orderId);
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
 * 상차 준비 - 적치된 파렛트를 하나씩 내린다 (당일상차리스트의 로케이션 팝업).
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

/** 주문별 적치 진행 수 { done, total } */
export async function stowCount(orderId) {
    const mine = (await load()).pallets.filter((p) => p.order_id === orderId);
    return { done: mine.filter((p) => p.location).length, total: mine.length };
}

/**
 * 파렛트 바코드 스캔 처리 (상차 검수)
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

    // 상차라벨의 바코드는 주문번호다. 파렛트마다 같은 라벨이 붙으므로
    // 주문번호를 스캔할 때마다 아직 검수되지 않은 파렛트를 하나씩 채운다.
    // (예전 방식인 파렛트 개별 바코드 {주문번호}-P01 도 그대로 인식한다)
    //
    // 🔑 추가주문은 라벨이 자기 번호(`a11111-1`)로 인쇄되고 1차수와 함께 실린다.
    // 대표 번호든 추가차수 번호든 **같은 묶음이면 모두 인식한다.**
    const groupNos = new Set(group.rows.map((r) => String(r.order_no).trim().toUpperCase()));
    const isOrderCode = groupNos.has(code);
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
    // 차수별 검수 수를 각각 갱신하고, 그 차수가 다 차면 검수 상태로 올린다
    group.rows.forEach((r) => {
        r.inspected = db.pallets.filter((p) => p.order_id === r.id && p.scanned_at).length;
        if (r.inspected >= r.pallet_count && r.load_status === LOAD_STATUS.WAIT) {
            r.load_status = LOAD_STATUS.INSPECTED;
            addHistory(db, r.id, '검수', '대기', '검수완료', user);
        }
    });
    const done = mine.filter((p) => p.scanned_at).length;
    await save(db);
    return { ok: true, msg: `검수 완료 (${done}/${mine.length})`, order: o };
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
        throw new Error('상차완료된 주문입니다. 당일상차리스트에서 상차완료를 먼저 취소하세요.');
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

/** 상차완료 처리 */
export async function completeLoading(orderId, user) {
    const db = (await load());
    const group = groupOf(db, orderId);
    if (!group) throw new Error('주문을 찾을 수 없습니다.');
    // 추가주문까지 함께 실리므로 차수 전체가 검수되어야 상차완료할 수 있다
    if (group.rows.some((r) => r.load_status !== LOAD_STATUS.INSPECTED)) {
        throw new Error('검수가 완료된 건만 상차완료 처리할 수 있습니다.');
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
    group.rows.forEach((r) => {
        r.loaded_at = null;
        // 상차만 되돌린다. 상차검수는 실제 스캔한 수를 보고 상태를 정한다
        // (전량 검수돼 있으면 '검수', 아니면 '대기' — 값을 고정하면 어긋난 건이 남는다)
        r.load_status = r.pallet_count > 0 && r.inspected >= r.pallet_count
            ? LOAD_STATUS.INSPECTED
            : LOAD_STATUS.WAIT;
        addHistory(db, r.id, '상차작업', '완료', '취소', user);
    });
    await save(db);
    return group.head;
}

/**
 * 출고 완료처리 / 완료처리 취소.
 * 상차작업까지 끝난 주문을 용마담당자가 최종 마감하는 단계다.
 * 완료처리된 주문은 주문처리현황의 `현재진행` 탭에서 빠지고 `출고완료` 탭으로 간다.
 */
export async function closeOrder(id, done, user) {
    const db = (await load());
    const o = db.orders.find((x) => x.id === id);
    if (!o) throw new Error('주문을 찾을 수 없습니다.');
    if (o.canceled_at) throw new Error('취소된 주문입니다.');
    if (done && !loadDone(o)) {
        throw new Error('상차작업까지 완료된 주문만 완료처리할 수 있습니다.');
    }
    o.closed_at = done ? new Date().toISOString() : null;
    addHistory(db, id, '출고완료', done ? '진행' : '완료', done ? '완료' : '진행', user);
    await save(db);
    return o;
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
export async function acceptIssue(id, assigneeId) {
    const db = (await load());
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error('이슈를 찾을 수 없습니다.');
    if (i.status !== ISSUE_STATE.WAIT) {
        throw new Error(`${ISSUE_STATE.WAIT} 상태의 이슈만 접수할 수 있습니다.`);
    }
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

