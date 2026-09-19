/**
 * 유통가공작업의 **순수 계산** 🔑 (DOM·저장소를 모른다 · docs/processing.md).
 *
 * 구성품 전개 · LOT 분할 · 문서번호 채번 · 작업캘린더 레인 배치처럼 **불변식이 있는 계산**만
 * 모아 둔다. 화면(pages/processing/*)과 업무 규칙(db.js)이 같은 함수를 부르므로
 * 같은 값을 두 곳에서 따로 계산하는 일이 없다.
 *
 * `checkflow.js` 와 같은 자리다 - 브라우저 없이 부를 수 있어
 * `tools/processing-check.js` 가 랜덤 입력으로 불변식(C1~C5)을 센다.
 * 배치·검증을 건드리면 `npm run check:processing` 을 돌린다.
 */
import { addDays, toDateStr } from './util.js';

/** 캘린더 한 칸에 그리는 막대 수 상한. 넘친 조각은 `+N` 으로만 표시한다 (docs/processing.md A11) */
export const CAL_MAX_LANE = 3;

/** 캘린더 그리드 칸 수 - 일~토 6주 고정 (달마다 높이가 변하지 않게 한다) */
export const CAL_CELLS = 42;

/* ------------------------------ 구성품 · 필요수량 ------------------------------ */

/**
 * 필요수량 = 작업 1개당 소요량 × 작업수량.
 * 🔑 **저장 컬럼을 두지 않는다.** 같은 값을 두 곳에 두면 작업수량을 고칠 때 반드시 어긋난다.
 */
export function needQty(qtyPer, jobQty) {
    return (Number(qtyPer) || 0) * (Number(jobQty) || 0);
}

/**
 * 마스터 구성품을 작업 구성품 줄로 펼친다.
 * `line_no` 는 **1부터**이고, 같은 줄의 LOT 행들을 묶는 키가 된다.
 * @param {Array<{kind:string, code?:string, name:string, qty_per:number}>} items 마스터 구성품
 * @param {number} jobQty 작업수량
 */
export function expandMasterItems(items, jobQty) {
    return (items ?? []).map((it, i) => ({
        line_no: i + 1,
        kind: it.kind,
        code: String(it.code ?? ''),
        name: String(it.name ?? ''),
        qty_per: Number(it.qty_per) || 0,
        need_qty: needQty(it.qty_per, jobQty),
    }));
}

/* --------------------------------- LOT 분할 --------------------------------- */

/** 1 이상 정수만 수량으로 인정한다 (그 밖은 0 으로 세고 오류는 validateLots 가 낸다) */
function lotQty(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * LOT 행의 **마지막 행에 잔량을 채운다** (docs/processing.md §10).
 * 잔량이 0 이하면 그대로 두고, 오류는 `validateLots` 가 낸다.
 *
 * 🔑 사용자가 마지막 행을 직접 고쳤으면(`touched`) 덮어쓰지 않는다 -
 * 자동 보정이 사용자가 방금 친 값을 지우면 입력을 포기하게 된다.
 *
 * @param {Array<{lot?:string, qty?:number|string, touched?:boolean}>} rows
 * @param {number} need 필요수량
 * @returns {Array} 새 배열 (원본을 바꾸지 않는다)
 */
export function normalizeLots(rows, need) {
    const list = (rows ?? []).map((r) => ({ ...r }));
    if (!list.length) return list;
    const last = list[list.length - 1];
    if (last.touched) return list;
    const head = list.slice(0, -1).reduce((sum, r) => sum + lotQty(r.qty), 0);
    const rest = (Number(need) || 0) - head;
    if (rest > 0) last.qty = rest;
    return list;
}

/**
 * LOT 행 검증 🔑 (화면과 `db.createProcessJob` 이 **같은 함수**를 쓴다).
 *
 *   행별 : 수량은 1 이상 정수 · 2행 이상이면 LOT 필수 · 같은 줄 안에서 LOT 중복 금지
 *   합계 : 합계 === 필요수량 (초과/부족을 문구로 돌려준다)
 *
 * @returns {{ok:boolean, total:number, diff:number, sumMsg:string,
 *   errors:Array<{index:number, field:string, msg:string}>}}
 *   `field` 는 `'qty'`/`'lot'` - 어느 입력칸에 빨간 테두리를 칠지 화면이 안다.
 *   `diff`·`sumMsg` 는 줄 끝에 빨강으로 붙이는 합계 오류다 (설계서의 `{ok,total,errors}` 확장).
 */
export function validateLots(rows, need) {
    const list = rows ?? [];
    const errors = [];
    const seen = new Set();
    let total = 0;

    list.forEach((r, index) => {
        const qty = Number(r.qty);
        if (!Number.isInteger(qty) || qty <= 0) {
            errors.push({ index, field: 'qty', msg: '수량은 1 이상 정수로 입력하세요.' });
        } else {
            total += qty;
        }
        const lot = String(r.lot ?? '').trim();
        if (!lot && list.length > 1) {
            errors.push({ index, field: 'lot', msg: '행이 2개 이상이면 LOT 을 입력해야 합니다.' });
        } else if (lot && seen.has(lot)) {
            errors.push({ index, field: 'lot', msg: '같은 구성품 줄에 LOT 이 중복됩니다.' });
        }
        if (lot) seen.add(lot);
    });

    const diff = total - (Number(need) || 0);
    const sumMsg = diff === 0 ? '' : (diff > 0 ? `${diff} 초과` : `${-diff} 부족`);
    return { ok: list.length > 0 && !errors.length && !sumMsg, total, diff, sumMsg, errors };
}

/* ------------------------------ 검수 사진 슬롯 ------------------------------ */

/**
 * 작업전 검수의 사진 슬롯 = **구성품 줄 번호**(`line_no`) 집합 (docs/processing.md §17-2 · A19).
 * 한 구성품을 LOT 3개로 나눠도 실물은 한 품목이라 사진은 1장이다.
 */
export function photoLines(items) {
    // 줄 번호는 1부터다(expandMasterItems). 서버 CHECK(process_photos_slot_chk)도 같은 값을
    // 요구하므로 0·음수를 여기서 걸러 「저장은 되는데 서버가 거부」 하는 경로를 만들지 않는다
    return [...new Set((items ?? []).map((i) => Number(i.line_no)))]
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
}

/**
 * 있어야 할 슬롯 중 **아직 없는 것** (검수완료 허용 조건의 근거).
 * @param {Array<number>} expected 있어야 할 슬롯 키
 * @param {Array<number>} have 사진 메타가 있는 슬롯 키
 */
export function missingSlots(expected, have) {
    const got = new Set((have ?? []).map(Number));
    return [...new Set((expected ?? []).map(Number))]
        .filter((n) => !got.has(n))
        .sort((a, b) => a - b);
}

/* --------------------------------- 문서번호 --------------------------------- */

/** 'YYYY-MM-DD' · Date · ISO 문자열을 `YYYYMMDD` 로 (문서번호 앞자리) */
export function docDateKey(date) {
    const src = date instanceof Date ? toDateStr(date) : String(date ?? '');
    return src.slice(0, 10).replace(/-/g, '');
}

/**
 * 문서번호 `YYYYMMDD-NN`.
 * 순번은 2자리로 채우고, **99 를 넘으면 자릿수를 늘린다**(`-100`).
 */
export function formatDocNo(date, seq) {
    const n = Math.max(1, Math.trunc(Number(seq) || 1));
    return `${docDateKey(date)}-${String(n).padStart(2, '0')}`;
}

/**
 * 문서번호 분해. 형식이 아니면 null.
 * 🔑 순번은 **숫자로** 돌려준다 - 문자열로 비교하면 자릿수가 다를 때 `-9` > `-100` 이 된다.
 */
export function parseDocNo(no) {
    const m = /^(\d{8})-(\d{2,})$/.exec(String(no ?? '').trim());
    if (!m) return null;
    return { date: m[1], seq: Number(m[2]) };
}

/** 그 날짜의 다음 순번 (없으면 1) */
export function nextDocSeq(docNos, date) {
    const key = docDateKey(date);
    const max = (docNos ?? []).reduce((mx, no) => {
        const p = parseDocNo(no);
        return p && p.date === key ? Math.max(mx, p.seq) : mx;
    }, 0);
    return max + 1;
}

/* -------------------------------- 작업캘린더 -------------------------------- */

/** 날짜 값을 `YYYY-MM-DD` 로. 형식이 아니면 빈 문자열 */
function dayOnly(v) {
    const s = String(v ?? '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** 두 날짜 사이의 일수 (같은 날이면 0) */
function dayGap(from, to) {
    return Math.round(
        (new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000,
    );
}

/**
 * 월 그리드 - `'YYYY-MM'` → 일~토 6주(42칸) 날짜 배열.
 * 그 달 1일이 속한 주의 **일요일**부터 시작한다 (달마다 높이가 변하지 않는다).
 */
export function calendarGrid(month) {
    const [y, m] = String(month ?? '').split('-').map(Number);
    const first = new Date(y, (m || 1) - 1, 1);
    const start = toDateStr(new Date(y, (m || 1) - 1, 1 - first.getDay()));
    return Array.from({ length: CAL_CELLS }, (_, i) => addDays(start, i));
}

/**
 * 작업 막대의 레인 배치 🔑 (docs/processing.md §12 · 불변식 C1~C5).
 *
 *   1 그리드와 하루라도 겹치는 작업만 (정렬 = 시작일 ↑ → 기간 긴 것 먼저 → id)
 *   2 주 경계를 넘으면 **주마다 조각**으로 자른다 (`startsHere`/`endsHere` 로 끝 모양을 정한다)
 *   3 각 주에서 **겹치지 않는 가장 작은 lane** 에 넣는다 (레인은 주마다 다시 배정한다)
 *   4 `lane >= maxLane` 이면 그리지 않고 그 조각이 덮는 날짜 칸마다 `overflow` 를 센다
 *
 * @param {Array<{id:string, start_date:string, due_date:string}>} jobs
 * @param {string} month `'YYYY-MM'`
 * @param {{maxLane?:number}} [opt]
 * @returns {{weeks:Array<{days:string[], bars:Array, hidden:Array, overflow:number[]}>}}
 *   `hidden` 은 넘쳐서 그리지 않은 조각이다 - `+N` 을 눌렀을 때 무엇이 숨었는지 알아야 하고,
 *   불변식 검사(C3·C5)도 이 값으로 센다 (설계서 반환 모양의 확장).
 */
export function calendarLanes(jobs, month, opt = {}) {
    const maxLane = Math.max(0, Math.trunc(opt.maxLane ?? CAL_MAX_LANE));
    const days = calendarGrid(month);
    const gridFrom = days[0];
    const gridTo = days[CAL_CELLS - 1];

    const targets = (jobs ?? [])
        .map((j) => {
            const s = dayOnly(j.start_date);
            const e = dayOnly(j.due_date);
            // 완료요청일이 시작일보다 앞선 옛 데이터는 하루짜리로 본다 (db 가 막지만 방어한다)
            return { id: j.id, s, e: e && e >= s ? e : s };
        })
        .filter((j) => j.s && j.s <= gridTo && j.e >= gridFrom)
        .sort((a, b) => {
            if (a.s !== b.s) return a.s < b.s ? -1 : 1;
            const gap = dayGap(b.s, b.e) - dayGap(a.s, a.e);
            if (gap) return gap;
            return String(a.id) < String(b.id) ? -1 : 1;
        });

    const weeks = [];
    for (let w = 0; w < CAL_CELLS / 7; w += 1) {
        const wd = days.slice(w * 7, w * 7 + 7);
        const bars = [];
        const hidden = [];
        const overflow = wd.map(() => 0);
        const lanes = [];                     // lanes[l] = [[colStart, colEnd], ...]

        targets.forEach((j) => {
            const from = j.s > wd[0] ? j.s : wd[0];
            const to = j.e < wd[6] ? j.e : wd[6];
            if (from > to) return;
            const colStart = wd.indexOf(from);
            const colEnd = wd.indexOf(to);
            if (colStart < 0 || colEnd < 0) return;

            const seg = {
                jobId: j.id,
                colStart,
                colSpan: colEnd - colStart + 1,
                startsHere: j.s === from,
                endsHere: j.e === to,
            };
            let lane = 0;
            while (lane < maxLane
                && (lanes[lane] ?? []).some(([a, b]) => a <= colEnd && colStart <= b)) {
                lane += 1;
            }
            if (lane >= maxLane) {
                hidden.push(seg);
                for (let i = colStart; i <= colEnd; i += 1) overflow[i] += 1;
                return;
            }
            if (!lanes[lane]) lanes[lane] = [];
            lanes[lane].push([colStart, colEnd]);
            bars.push({ ...seg, lane });
        });

        weeks.push({ days: wd, bars, hidden, overflow });
    }
    return { weeks };
}
