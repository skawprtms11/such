/**
 * Supabase 구축 전 사용하는 초기 샘플 데이터.
 * 최초 1회 localStorage 에 적재되며, 이후에는 사용자가 조작한 값이 유지된다.
 */
import { ROLE, COMPANY, LOAD_STATUS } from './config.js';
import { today, toDateStr } from './util.js';

const d = (offset) => {
    const dt = new Date();
    dt.setDate(dt.getDate() + offset);
    return toDateStr(dt);
};

export const SEED_USERS = [
    {
        id: 'u_admin', name: '김관리', email: 'admin@thepurelab.co.kr',
        role: ROLE.ADMIN, company: COMPANY.CUSTOMER, phone: '010-0000-0001', active: true,
    },
    {
        id: 'u_yongma', name: '박용마', email: 'yongma@yongma.co.kr',
        role: ROLE.YONGMA, company: COMPANY.LOGISTICS, phone: '010-0000-0002', active: true,
    },
    {
        id: 'u_shipper', name: '이화주', email: 'manager@thepurelab.co.kr',
        role: ROLE.SHIPPER_ADMIN, company: COMPANY.CUSTOMER, phone: '010-0000-0003', active: true,
    },
    {
        id: 'u_sales1', name: '최영업', email: 'sales1@thepurelab.co.kr',
        role: ROLE.SHIPPER_SALES, company: COMPANY.CUSTOMER, phone: '010-0000-0004', active: true,
    },
    {
        id: 'u_sales2', name: '정영업', email: 'sales2@thepurelab.co.kr',
        role: ROLE.SHIPPER_SALES, company: COMPANY.CUSTOMER, phone: '010-0000-0005', active: true,
    },
    {
        id: 'u_worker', name: '한현장', email: 'worker@partner.co.kr',
        role: ROLE.WORKER, company: COMPANY.PARTNER, phone: '010-0000-0006', active: true,
    },
];

/**
 * 주문 1건 생성 헬퍼
 * done: 완료 처리할 단계 키 목록 ('order' 'ship' 'request' 'inspect' 'extra' 'load')
 */
function order(o) {
    const at = (key) => ((o.done ?? []).includes(key) ? `${o.reg_date}T10:00:00` : null);
    return {
        id: o.id,
        reg_date: o.reg_date,
        send_date: o.send_date,
        seq: o.seq ?? 1,
        order_no: o.order_no,
        customer: o.customer,
        ship_req_date: o.ship_req_date,
        vehicle_type: o.vehicle_type,
        extra_works: o.extra_works ?? [],
        request_note: o.request_note ?? '',
        remark: o.remark ?? '',
        item_count: o.item_count ?? 0,
        qty: o.qty ?? 0,
        pallet_count: o.pallet_count ?? 0,
        box_count: o.box_count ?? 0,
        confirmed_at: at('order'),
        ship_started_at: (o.done ?? []).includes('ship') ? `${o.reg_date}T09:30:00` : null,
        ship_done_at: at('ship'),
        req_work_at: at('request'),
        packing_at: at('inspect'),
        inspect_done_at: at('inspect'),
        stow_done_at: at('stow'),
        extra_done_at: at('extra'),
        loaded_at: at('load'),
        canceled_at: null,
        edit_count: 0,
        inspected: o.inspected ?? 0,
        load_status: o.load_status ?? LOAD_STATUS.WAIT,
        created_by: o.created_by,
        created_at: `${o.reg_date}T09:00:00`,
    };
}

export const SEED_ORDERS = [
    order({
        id: 'o_1001', reg_date: today(), send_date: today(), order_no: 'PO-24080101',
        customer: '올리브영 물류센터', ship_req_date: today(), vehicle_type: '용차',
        request_note: '오전 상차 요청', remark: '파렛트 규격 T11',
        item_count: 12, qty: 4800, pallet_count: 6, box_count: 144,
        done: ['order', 'ship', 'inspect'],
        inspected: 0, load_status: LOAD_STATUS.WAIT, created_by: 'u_sales1',
    }),
    order({
        id: 'o_1002', reg_date: today(), send_date: today(), order_no: 'PO-24080102',
        customer: '쿠팡 대구FC', ship_req_date: today(), vehicle_type: '픽업',
        extra_works: ['라벨작업'], request_note: '박스 라벨 별도 부착', remark: '',
        item_count: 8, qty: 2400, pallet_count: 3,
        done: ['order', 'ship'],
        inspected: 3, load_status: LOAD_STATUS.INSPECTED, created_by: 'u_sales1',
    }),
    order({
        id: 'o_1003', reg_date: today(), send_date: today(), order_no: 'PO-24080103',
        customer: '이마트 김포센터', ship_req_date: d(1), vehicle_type: '용차',
        extra_works: ['라벨작업', '박스교체'], request_note: '', remark: '냉장 구분 적재',
        item_count: 20, qty: 9600, pallet_count: 10,
        done: ['order'],
        created_by: 'u_sales2',
    }),
    order({
        id: 'o_1004', reg_date: today(), send_date: today(), seq: 2,
        order_no: 'PO-24080101', customer: '올리브영 물류센터', ship_req_date: d(1),
        vehicle_type: '용차', request_note: '추가 출고분', remark: '1차수 건과 동일 차량',
        item_count: 3, qty: 900, pallet_count: 1,
        done: [],
        created_by: 'u_sales1',
    }),
    order({
        id: 'o_1005', reg_date: d(-1), send_date: d(-1), order_no: 'PO-24073101',
        customer: '롯데마트 오산점', ship_req_date: today(), vehicle_type: '픽업',
        request_note: '13시 이전 출고', remark: '',
        item_count: 5, qty: 1500, pallet_count: 2, box_count: 48,
        done: ['order', 'ship', 'inspect', 'stow', 'load'],
        inspected: 2, load_status: LOAD_STATUS.DONE, created_by: 'u_sales2',
    }),
    order({
        id: 'o_1007', reg_date: today(), send_date: today(), order_no: 'PO-24080105',
        customer: '홈플러스 안양점', ship_req_date: today(), vehicle_type: '용차',
        request_note: '', remark: '검수 실측 반영 건',
        item_count: 9, qty: 3600, pallet_count: 4, box_count: 96,
        done: ['order', 'ship', 'inspect', 'stow'],
        inspected: 0, load_status: LOAD_STATUS.WAIT, created_by: 'u_sales1',
    }),
    order({
        id: 'o_1006', reg_date: today(), send_date: today(), order_no: 'PO-24080104',
        customer: '무신사 스토어', ship_req_date: d(2), vehicle_type: '픽업',
        request_note: '', remark: '',
        item_count: 6, qty: 1800, pallet_count: 2,
        done: [],
        created_by: 'u_sales2',
    }),
];

export const SEED_ISSUES = [
    {
        id: 'i_1', created_at: `${today()}T10:20:00`, type: '오출고',
        title: '쿠팡 대구FC 오출고 확인 요청', order_no: 'PO-24080102',
        content: '요청 수량 대비 2박스 초과 출고된 것으로 확인됩니다. 회수 절차 문의드립니다.',
        due_date: d(1), status: '확인중', created_by: 'u_sales1',
    },
    {
        id: 'i_2', created_at: `${d(-1)}T15:05:00`, type: '재고부족',
        title: '이마트 김포센터 A품목 재고 부족', order_no: 'PO-24080103',
        content: 'A-102 품목 재고가 300ea 부족합니다. 분할 출고 가능 여부 회신 바랍니다.',
        due_date: today(), status: '접수', created_by: 'u_sales2',
    },
    {
        id: 'i_3', created_at: `${today()}T09:10:00`, type: '작업요청',
        title: '올리브영 물류센터 재포장 요청', order_no: 'PO-24080101',
        content: '파렛트 3~4번 박스를 T11 규격으로 재포장 후 스트레치 랩 2회 감아주세요.',
        due_date: today(), status: '접수', created_by: 'u_sales1',
    },
];

/** 검수용 파렛트 바코드 - 주문별로 파렛트 수만큼 자동 생성 */
export function makePallets(orderRow) {
    const list = [];
    for (let i = 1; i <= orderRow.pallet_count; i += 1) {
        list.push({
            id: `${orderRow.id}_p${i}`,
            order_id: orderRow.id,
            barcode: `${orderRow.order_no}-P${String(i).padStart(2, '0')}`,
            scanned_at: i <= orderRow.inspected ? `${orderRow.reg_date}T11:00:00` : null,
            // 출고적치 로케이션. 적치가 끝난 주문만 값이 들어 있다
            location: orderRow.stow_done_at
                ? `IF-01-${String(i).padStart(2, '0')}-01` : '',
        });
    }
    return list;
}
