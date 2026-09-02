/**
 * 시스템 전역 설정
 * Supabase 연동 전에는 DATA_SOURCE 가 'mock' 이며 localStorage 로 동작한다.
 * Supabase 구축 후에는 .env.local 에 VITE_SUPABASE_* 값을 채우고
 * VITE_DATA_SOURCE=supabase 로 바꾸면 된다. (.env.example 참고)
 */
const ENV = import.meta.env ?? {};

/** 'mock' | 'supabase' */
export const DATA_SOURCE = ENV.VITE_DATA_SOURCE ?? 'mock';

export const SUPABASE = {
    url: ENV.VITE_SUPABASE_URL ?? '',
    anonKey: ENV.VITE_SUPABASE_ANON_KEY ?? '',
};

/** 사용자 권한 코드 */
export const ROLE = {
    ADMIN: 'admin',                 // 관리자
    YONGMA: 'yongma',               // 용마담당자
    SHIPPER_ADMIN: 'shipper_admin', // 화주관리자
    SHIPPER_SALES: 'shipper_sales', // 화주영업팀
    WORKER: 'worker',               // 현장작업자 (협력사 - 앱으로 출고·상차만 처리)
};

export const ROLE_LABEL = {
    [ROLE.ADMIN]: '관리자',
    [ROLE.YONGMA]: '용마담당자',
    [ROLE.SHIPPER_ADMIN]: '화주관리자',
    [ROLE.SHIPPER_SALES]: '화주영업팀',
    [ROLE.WORKER]: '현장작업자',
};

/**
 * 소속(회사) 구분
 * 권한 판정에 쓰이므로 자유 입력이 아니라 이 목록에서만 고른다.
 */
export const COMPANY = {
    CUSTOMER: '고객사',      // 화주 (주문을 등록하는 쪽)
    LOGISTICS: '용마로지스',  // 물류사 (주문을 처리·확인하는 쪽)
    PARTNER: '협력사',        // 현장 작업을 맡는 협력사 (앱만 사용한다)
};

export const COMPANIES = Object.values(COMPANY);

/**
 * 권한별 기능 매트릭스
 * viewAll      : 전체 주문 조회 (false 면 본인 등록건만)
 * download     : 엑셀(CSV) 다운로드
 * manageUsers  : 사용자 권한 변경
 * createOrder  : 주문 등록/수정
 * updateStatus : 출고·검수·적치·상차 처리
 * createIssue  : 이슈 등록 (상태 변경은 updateStatus 와 함께 있어야 한다)
 * closeOrder   : 주문처리현황의 출고 완료처리
 */
export const PERMISSION = {
    [ROLE.ADMIN]: {
        viewAll: true, download: true, manageUsers: true,
        createOrder: true, updateStatus: true, createIssue: true, closeOrder: true,
    },
    [ROLE.YONGMA]: {
        viewAll: true, download: true, manageUsers: false,
        createOrder: false, updateStatus: true, createIssue: true, closeOrder: true,
    },
    [ROLE.SHIPPER_ADMIN]: {
        viewAll: true, download: true, manageUsers: false,
        createOrder: true, updateStatus: false, createIssue: true, closeOrder: false,
    },
    [ROLE.SHIPPER_SALES]: {
        viewAll: false, download: true, manageUsers: false,
        createOrder: true, updateStatus: false, createIssue: true, closeOrder: false,
    },
    // 현장작업자 - 출고주문처리·당일상차리스트만 처리하고 나머지는 조회만 한다
    [ROLE.WORKER]: {
        viewAll: true, download: false, manageUsers: false,
        createOrder: false, updateStatus: true, createIssue: false, closeOrder: false,
    },
};

/** 협력사 소속은 앱(모바일) 메뉴만 쓴다 */
export function appOnlyCompany(company) {
    return company === COMPANY.PARTNER;
}

/**
 * 주문정보등록 화면 전용 권한 정책.
 * 역할이 목록에 있거나, 소속이 목록에 있으면 허용한다.
 *
 * - 관리자·화주관리자 : 소속과 무관하게 모든 작업 가능
 * - 화주영업팀·용마담당자 : 소속으로 갈린다
 *     고객사   → 등록·수정·조정요청 (작성)
 *     용마로지스 → 조회 + 접수/수정/조정 확인 체크, 이력 확인처리
 */
export const ORDER_POLICY = {
    /** 신규 등록 · 수정 · 조정요청 등록 */
    write: {
        roles: [ROLE.ADMIN, ROLE.SHIPPER_ADMIN],
        companies: [COMPANY.CUSTOMER],
    },
    /** 확인 컬럼 체크 · 이력의 확인처리 */
    confirm: {
        roles: [ROLE.ADMIN, ROLE.SHIPPER_ADMIN],
        companies: [COMPANY.LOGISTICS],
    },
};

/**
 * 주문 진행상태 (저장하지 않고 주문 상태에서 계산한다)
 *   대기 : 등록만 된 상태
 *   진행 : 접수 처리됨
 *   완료 : 상차완료까지 끝남
 *   취소 : 취소 처리됨 (다른 상태보다 우선한다)
 */
export const PROGRESS = {
    WAIT: '대기',
    DOING: '진행',
    DONE: '완료',
    CANCELED: '취소',
};

/**
 * 출고 처리 단계 (주문처리현황 · 출고주문처리가 공유한다)
 *   at   : 완료 시각이 담기는 주문 필드. 값이 있으면 완료로 본다
 *   cond : 조건부 단계. 해당 조건일 때만 화면에 표시한다
 *          'extra'  - 주문에 추가작업(라벨작업 등)이 등록된 경우
 *          'adjust' - 조정요청이 등록된 경우 (완료 여부는 요청 확인 상태로 계산한다)
 *          'task'   - 추가작업 요청이 등록된 경우
 *
 * 완료 처리 위치
 *   주문처리 → 주문정보등록의 접수 체크
 *   출고작업 → 출고주문처리 > 출고작업 탭
 *   요청작업 → 출고주문처리 > 검수작업 탭의 요청작업 확인
 *   검수작업 → 출고주문처리 > 검수작업 탭
 *   조정작업 → 주문정보등록 이력 팝업에서 조정요청을 모두 확인 처리할 때
 *   추가작업 → 출고주문처리 > 추가작업 탭
 *   상차작업 → 당일상차리스트의 상차완료
 */
export const WORK_STEPS = [
    { key: 'order', label: '주문처리', at: 'confirmed_at' },
    { key: 'ship', label: '출고작업', at: 'ship_done_at' },
    { key: 'request', label: '요청작업', at: 'req_work_at', cond: 'extra' },
    { key: 'inspect', label: '검수작업', at: 'inspect_done_at' },
    { key: 'stow', label: '출고적치', at: 'stow_done_at' },
    { key: 'adjust', label: '조정작업', cond: 'adjust' },
    { key: 'extra', label: '추가작업', at: 'extra_done_at', cond: 'task' },
    { key: 'load', label: '상차작업', at: 'loaded_at' },
];

/**
 * 출고적치 상태 - 저장하지 않고 파렛트의 로케이션 입력 수로 계산한다.
 * 0개 = 적치대기 / 일부 = 적치중 / 전량 = 적치완료
 */
export const STOW_STATUS = {
    WAIT: '적치대기',
    ING: '적치중',
    DONE: '적치완료',
};

/**
 * 적치 로케이션 형식 - 영문 2자리 구역코드 + 2자리 숫자 3개.
 * 예: IF-01-03-01
 */
export const LOCATION_FORMAT = 'IF-01-03-01';

/**
 * 입력값을 로케이션 형식으로 맞춘다.
 * 영문과 숫자만 추려 `AA-00-00-00` 으로 끊는다. 덜 채워졌으면 있는 만큼만 만든다.
 */
export function formatLocation(raw) {
    const s = String(raw ?? '').toUpperCase();
    const zone = (s.match(/[A-Z]+/)?.[0] ?? '').slice(0, 2);
    const digits = s.replace(/[^0-9]/g, '').slice(0, 6);
    return [zone, ...(digits.match(/\d{1,2}/g) ?? [])].filter(Boolean).join('-');
}

/** 형식이 다 채워졌는지 (구역 영문 2자 + 숫자 2자리 3묶음) */
export function isValidLocation(raw) {
    return /^[A-Z]{2}-\d{2}-\d{2}-\d{2}$/.test(formatLocation(raw));
}

/**
 * 로케이션 정렬 비교 - 구역 → 행 → 열 → 단 오름차순.
 * 로케이션이 없는 항목은 뒤로 보낸다.
 */
export function compareLocation(a, b) {
    const parse = (v) => {
        const f = formatLocation(v);
        if (!f) return null;
        const [zone, ...nums] = f.split('-');
        return { zone, nums: nums.map(Number) };
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return (pa ? -1 : 0) + (pb ? 1 : 0);
    if (pa.zone !== pb.zone) return pa.zone.localeCompare(pb.zone);
    for (let i = 0; i < 3; i += 1) {
        const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

/** 파렛트 표시 이름 - 주문번호에 파렛트 번호를 붙인다 (예: PO-24080101-01) */
export function palletLabel(orderNo, index) {
    return `${orderNo}-${String(index + 1).padStart(2, '0')}`;
}

/** 적치 상태 판정 - 로케이션이 입력된 파렛트 수로 계산한다 */
export function stowStatus(done, total) {
    if (!total || !done) return STOW_STATUS.WAIT;
    return done >= total ? STOW_STATUS.DONE : STOW_STATUS.ING;
}

/**
 * 추가작업 요청의 출처.
 * 이슈등록에서 이 유형으로 등록된 건을 해당 주문의 추가작업 요청으로 본다.
 */
export const EXTRA_TASK_TYPE = '작업요청';

/** 차량구분 */
export const VEHICLE_TYPES = ['픽업', '용차'];

/** 추가작업 (주문 등록 시 다중 선택) */
export const EXTRA_WORKS = ['라벨작업', '박스교체', 'LOT지정'];

/** 조정요청 작성 방식 */
export const RESTORE_TYPE = {
    EMAIL: 'email',   // 이메일로 발송 - 사유만 선택
    FORM: 'form',     // 여기에 작성 - 상세 항목 직접 입력
};

export const RESTORE_TYPE_LABEL = {
    [RESTORE_TYPE.EMAIL]: '이메일로 발송',
    [RESTORE_TYPE.FORM]: '여기에 작성',
};

/**
 * 조정 사유 목록 ('이메일로 발송' 선택 시 사용)
 * ⚠️ 실제 업무에서 쓰는 사유로 확정되지 않은 임시 목록이다.
 */
export const RESTORE_REASONS = [
    '주문 취소',
    '수량 변경',
    '제품 변경',
    '출고일 변경',
    '거래처 변경',
    '오등록',
    '기타',
];

/**
 * 조정요청 항목.
 * key   : 저장값
 * label : 화면 문구
 * desc  : 선택 시 아래에 표시하는 설명
 * cancelsOrder : true 면 저장 시 주문이 취소 처리된다
 */
export const ADJUST_CATEGORIES = [
    {
        key: 'cancel_all',
        label: '전체취소',
        desc: '주문 전체 취소 처리 (복구 불가하며 주문 재등록 필요)',
        cancelsOrder: true,
    },
    { key: 'cancel_part', label: '부분취소', desc: '특정 제품 또는 특정 수량만 취소' },
    { key: 'hold_all', label: '전체보류', desc: '주문 전체 출고상차 보류 (출고 작업은 진행)' },
    {
        key: 'hold_part',
        label: '부분보류',
        desc: '특정 제품 또는 특정 수량만 출고상차 보류 (출고 작업은 진행)',
    },
    { key: 'etc', label: '기타요청', desc: '그 외 특이사항 요청' },
];

/** 항목 키로 정의를 찾는다 */
export function adjustCategory(key) {
    return ADJUST_CATEGORIES.find((c) => c.key === key) ?? ADJUST_CATEGORIES.at(-1);
}

/** 검수/상차 상태 */
export const LOAD_STATUS = { WAIT: '대기', INSPECTED: '검수', DONE: '완료' };

/** 이슈 유형 / 상태 */
export const ISSUE_TYPES = ['오출고', '재고부족', '작업요청', '기타'];
export const ISSUE_STATUS = ['접수', '확인중', '종결'];

/**
 * 메뉴 정의
 * icon      : icons.js 의 아이콘 키
 * adminOnly : 관리자에게만 노출
 * mobile    : 모바일 하단 탭바에 노출 (false 인 메뉴는 햄버거 서랍에서만 접근)
 */
export const MENUS = [
    { key: 'orders', path: '#/orders', label: '주문정보등록', icon: 'orders', mobile: false },
    { key: 'status', path: '#/status', label: '주문처리현황', icon: 'status', mobile: true },
    { key: 'shipping', path: '#/shipping', label: '출고주문처리', icon: 'shipping', mobile: true },
    { key: 'loading', path: '#/loading', label: '당일상차리스트', icon: 'loading', mobile: true },
    { key: 'issues', path: '#/issues', label: '이슈등록', icon: 'issues', mobile: true },
    {
        key: 'users',
        path: '#/users',
        label: '사용자관리',
        icon: 'users',
        adminOnly: true,
        mobile: false,
    },
];
