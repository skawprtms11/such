/**
 * 유통가공 순수 계산의 **불변식 검사** 🔑
 * (개발용 · `node tools/processing-check.js [반복수] [시드]` · `npm run check:processing`)
 *
 * `processing-calc.js` 는 순수 함수라 브라우저 없이 부를 수 있다. 랜덤 입력을 만들어
 * 「이건 절대 일어나면 안 된다」 를 세는 것이 전부다. 겹침·넘침·주 경계는 손으로 만든
 * 예시로는 조합이 몇 가지 안 나와, 랜덤 수천 건으로 세는 편이 훨씬 빠르게 결함을 잡는다
 * (업무프로세스 도식에서 문서에만 적어 둔 불변식을 두 번 깬 전례 - checkflow-check.js 와 같은 자리).
 *
 * 테스트 러너를 들이지 않은 이유 🔑 - 이 프로젝트에 테스트 프레임워크가 없고, 검사 대상이
 * **순수 함수 몇 개**라 의존성 없는 스크립트로 충분하다. 배치·검증을 건드리면 돌린다.
 *
 *   캘린더 C1 같은 주·같은 lane 의 두 막대는 날짜가 겹치지 않는다
 *          C2 `0 ≤ colStart` 이고 `colStart + colSpan ≤ 7`
 *          C3 작업이 덮는 그리드 내 모든 날짜는 **막대 또는 overflow 로 정확히 한 번** 계수된다
 *             (날짜칸마다 `overflow[i]` = 그 칸을 덮는 `hidden` 조각 수 - `+N` 팝업의 근거)
 *          C4 `lane < maxLane` (넘친 것은 bars 에 없다)
 *          C5 같은 작업의 조각을 이으면 원래 기간과 같다 (그리드로 잘린 부분 제외)
 *   그리드 G1 42칸 · 첫 칸은 일요일 · 하루씩 연속
 *   LOT   L1 잔량 자동 채움 뒤 합계 = 필요수량 (앞 행이 모두 유효하고 잔량이 남을 때)
 *         L2 `normalizeLots` 는 **앞 행을 바꾸지 않는다** (마지막 행만 손댄다)
 *         L3 `ok` 이면 합계 = 필요수량이고 오류가 없다 · 아니면 오류나 합계 문구가 있다
 *         L4 2행 이상인데 LOT 이 비었거나 중복이면 `ok` 가 아니다
 *   사진   P1 작업전 슬롯 = 구성품 줄 집합 (LOT 행이 몇 개든 줄마다 1장)
 *         P2 missingSlots 는 **찍지 않은 것만** 돌려준다 · 비면 전부 찍힌 것이다
 *         P3 문자열·중복·없는 줄이 섞여도 결과가 같다 (앱 슬롯 키는 문자열이다)
 *   구성품 B1 모든 입력 행이 **정확히 한 번** 어느 줄에 들어간다 (rows 합 = 입력 개수)
 *         B2 줄은 `line_no` 오름차순이고 줄 번호가 겹치지 않는다
 *         B3 줄 대표값(kind·code·name·qty_per)은 **그 줄 첫 입력 행**과 같고 rows 는 입력 순서다
 *            (웹 작업지시서와 앱 작업가이드가 같은 표를 그리는 근거 - docs/mobile.md §3-8)
 *   문서   D1 `parseDocNo(formatDocNo(d, n))` 이 원래 값과 같다 (세 자리 이상 포함)
 *         D2 `nextDocSeq` 는 그 날짜의 모든 순번보다 크다 (**숫자 비교** - 자릿수가 달라도)
 */
import process from 'node:process';
import {
    CAL_CELLS, calendarGrid, calendarLanes, formatDocNo, groupLines, missingSlots, needQty,
    nextDocSeq, normalizeLots, parseDocNo, photoLines, validateLots,
} from '../assets/js/processing-calc.js';

/** 시드 고정 난수 - 깨진 입력을 다시 만들어 볼 수 있어야 한다 (2번째 인자로 시드 교체) */
let seed = Number(process.argv[3] ?? 20260919) >>> 0;
function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
}
const pick = (n) => Math.floor(rnd() * n);

const fails = {
    C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, G1: 0, L1: 0, L2: 0, L3: 0, L4: 0, D1: 0, D2: 0,
    P1: 0, P2: 0, P3: 0, B1: 0, B2: 0, B3: 0,
};
const first = {};
function note(key, msg) {
    fails[key] += 1;
    if (!first[key]) first[key] = msg;
}

/* ------------------------------ 날짜 도우미 ------------------------------ */

const DAY = 86400000;
const toStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => new Date(`${s}T00:00:00`);
const shift = (s, n) => toStr(new Date(parse(s).getTime() + n * DAY));
const gap = (a, b) => Math.round((parse(b) - parse(a)) / DAY);

/** 두 날짜 사이의 모든 날짜 */
function range(from, to) {
    const out = [];
    for (let i = 0; i <= gap(from, to); i += 1) out.push(shift(from, i));
    return out;
}

/* -------------------------------- 캘린더 -------------------------------- */

function checkCalendar(t) {
    const month = `${2024 + pick(4)}-${String(1 + pick(12)).padStart(2, '0')}`;
    const maxLane = 1 + pick(4);
    const days = calendarGrid(month);

    // G1 - 42칸 · 일요일 시작 · 하루씩 연속
    if (days.length !== CAL_CELLS) note('G1', `t${t} ${month} 칸수 ${days.length}`);
    if (parse(days[0]).getDay() !== 0) note('G1', `t${t} ${month} 첫 칸 ${days[0]} 이 일요일 아님`);
    days.forEach((d, i) => {
        if (i && gap(days[i - 1], d) !== 1) note('G1', `t${t} ${days[i - 1]} → ${d}`);
    });

    // 그리드 안팎을 고루 섞는다 (한 달 전 ~ 한 달 뒤, 기간 1~20일)
    const jobs = Array.from({ length: pick(16) }, (_, i) => {
        const start = shift(days[0], pick(60) - 14);
        return { id: `j${t}_${i}`, start_date: start, due_date: shift(start, pick(20)) };
    });
    const { weeks } = calendarLanes(jobs, month, { maxLane });

    const gridFrom = days[0];
    const gridTo = days[CAL_CELLS - 1];
    /** 각 작업이 그리드 안에서 덮어야 하는 날짜 */
    const want = new Map();
    jobs.forEach((j) => {
        const from = j.start_date > gridFrom ? j.start_date : gridFrom;
        const to = j.due_date < gridTo ? j.due_date : gridTo;
        if (from <= to) want.set(j.id, range(from, to));
    });

    /** 실제로 계수된 날짜 (막대 · 숨김 각각) */
    const drawn = new Map();
    let hiddenCells = 0;
    let overflowCells = 0;

    weeks.forEach((week, wi) => {
        if (week.days.length !== 7) note('C2', `t${t} 주${wi} 날짜수 ${week.days.length}`);

        const lanes = new Map();
        week.bars.forEach((b) => {
            // C2
            if (b.colStart < 0 || b.colStart + b.colSpan > 7 || b.colSpan < 1) {
                note('C2', `t${t} 주${wi} ${b.jobId} ${b.colStart}+${b.colSpan}`);
            }
            // C4
            if (!(b.lane >= 0 && b.lane < maxLane)) {
                note('C4', `t${t} 주${wi} ${b.jobId} lane ${b.lane} (max ${maxLane})`);
            }
            // C1 - 같은 lane 안에서 겹치면 안 된다
            const key = b.lane;
            const mine = lanes.get(key) ?? [];
            const hit = mine.find(([a, z]) => a < b.colStart + b.colSpan && b.colStart <= z);
            if (hit) note('C1', `t${t} 주${wi} lane${b.lane} ${b.jobId} 겹침 [${hit}]`);
            mine.push([b.colStart, b.colStart + b.colSpan - 1]);
            lanes.set(key, mine);

            const list = drawn.get(b.jobId) ?? [];
            for (let i = 0; i < b.colSpan; i += 1) list.push(week.days[b.colStart + i]);
            drawn.set(b.jobId, list);
        });

        week.hidden.forEach((s) => {
            if (s.colStart < 0 || s.colStart + s.colSpan > 7 || s.colSpan < 1) {
                note('C2', `t${t} 주${wi} 숨김 ${s.jobId} ${s.colStart}+${s.colSpan}`);
            }
            hiddenCells += s.colSpan;
            const list = drawn.get(s.jobId) ?? [];
            for (let i = 0; i < s.colSpan; i += 1) list.push(week.days[s.colStart + i]);
            drawn.set(s.jobId, list);
        });
        overflowCells += week.overflow.reduce((a, b) => a + b, 0);

        // C3 - 날짜칸**마다** overflow 수와 그 칸을 덮는 hidden 조각 수가 같아야 한다.
        // 🔑 총합만 보면 「+3 인데 목록에는 1건」 같은 어긋남을 못 잡는다 -
        // 화면의 `+N` 팝업은 hidden 을 그 날짜로 걸러 목록을 만들고 숫자는 overflow 를 쓴다
        week.overflow.forEach((n, i) => {
            const cover = week.hidden
                .filter((s) => s.colStart <= i && i < s.colStart + s.colSpan).length;
            if (cover !== n) note('C3', `t${t} 주${wi} ${i}번칸 overflow ${n} != hidden ${cover}`);
        });
    });

    // C3 - overflow 총합은 숨긴 조각이 덮는 칸 수와 같아야 한다
    if (hiddenCells !== overflowCells) {
        note('C3', `t${t} 숨김 ${hiddenCells} != overflow ${overflowCells}`);
    }
    want.forEach((expect, id) => {
        const got = drawn.get(id) ?? [];
        // C3 - 같은 날짜를 두 번 세면 안 된다
        if (new Set(got).size !== got.length) note('C3', `t${t} ${id} 중복 계수`);
        // C5 - 조각을 이으면 원래 기간(그리드 안)과 같다
        const a = [...new Set(got)].sort().join(',');
        const b = expect.join(',');
        if (a !== b) note('C5', `t${t} ${id}\n      기대 ${b}\n      실제 ${a}`);
    });
    // 그리드 밖 작업은 아무것도 그리지 않아야 한다
    drawn.forEach((_, id) => {
        if (!want.has(id)) note('C5', `t${t} ${id} 는 그리드 밖인데 그려졌다`);
    });
}

/* ---------------------------------- LOT ---------------------------------- */

function checkLots(t) {
    const qtyPer = 1 + pick(5);
    const jobQty = 1 + pick(50);
    const need = needQty(qtyPer, jobQty);
    const n = 1 + pick(4);

    // 앞 행은 1 이상 정수로, 마지막 행은 비워 둔다 (잔량 자동 채움 대상)
    const rows = Array.from({ length: n }, (_, i) => ({
        lot: `L${i}`,
        qty: i === n - 1 ? 0 : 1 + pick(Math.max(1, Math.ceil(need / n))),
        touched: false,
    }));
    const head = rows.slice(0, -1).reduce((s, r) => s + r.qty, 0);
    const out = normalizeLots(rows, need);

    // L2 - 앞 행은 손대지 않는다
    out.slice(0, -1).forEach((r, i) => {
        if (r.qty !== rows[i].qty) note('L2', `t${t} ${i}번 행 ${rows[i].qty} → ${r.qty}`);
    });
    // L1 - 잔량이 남으면 합계가 필요수량과 같아진다
    const total = out.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    if (head < need && total !== need) note('L1', `t${t} 합계 ${total} != 필요 ${need}`);

    // L3 - ok 와 오류의 관계
    const v = validateLots(out, need);
    if (v.ok && (v.total !== need || v.errors.length || v.sumMsg)) {
        note('L3', `t${t} ok 인데 total ${v.total} / 오류 ${v.errors.length} / ${v.sumMsg}`);
    }
    if (!v.ok && !v.errors.length && !v.sumMsg) note('L3', `t${t} 오류 없는데 ok 아님`);

    // L4 - 2행 이상인데 LOT 이 비었거나 중복이면 통과하면 안 된다
    if (out.length > 1) {
        const at = pick(out.length);      // 🔑 map 안에서 pick() 을 부르면 행마다 달라진다
        const blank = out.map((r, i) => (i === at ? { ...r, lot: '  ' } : r));
        if (validateLots(blank, need).ok) note('L4', `t${t} 빈 LOT 이 통과했다`);
        const dup = out.map((r) => ({ ...r, lot: 'SAME' }));
        if (validateLots(dup, need).ok) note('L4', `t${t} 중복 LOT 이 통과했다`);
    }
    // 소수·음수·숫자 아님은 언제나 거부다
    [0, -1, 1.5, 'x'].forEach((bad) => {
        if (validateLots([{ lot: 'A', qty: bad }], need).ok) {
            note('L3', `t${t} 잘못된 수량 ${bad} 가 통과했다`);
        }
    });
}

/* --------------------------------- 문서번호 --------------------------------- */

function checkDocNo(t) {
    const date = `${2024 + pick(4)}-${String(1 + pick(12)).padStart(2, '0')}-${
        String(1 + pick(28)).padStart(2, '0')}`;
    const key = date.replace(/-/g, '');
    const seqs = Array.from({ length: 1 + pick(8) }, () => 1 + pick(200));

    seqs.forEach((n) => {
        const no = formatDocNo(date, n);
        const p = parseDocNo(no);
        if (!p || p.date !== key || p.seq !== n) note('D1', `t${t} ${no} → ${JSON.stringify(p)}`);
    });

    // 다른 날짜의 번호와 형식이 아닌 값이 섞여도 흔들리면 안 된다
    const noise = [null, '', 'abc', '2026-09-19', `${shift(date, 1).replace(/-/g, '')}-99`];
    const next = nextDocSeq(seqs.map((n) => formatDocNo(date, n)).concat(noise), date);
    const max = Math.max(...seqs);
    if (next !== max + 1) note('D2', `t${t} next ${next} != ${max + 1} (max ${max})`);
    if (nextDocSeq([], date) !== 1) note('D2', `t${t} 빈 목록의 다음 순번이 1 이 아니다`);
}

/* ------------------------------- 검수 사진 슬롯 ------------------------------- */

/**
 * 작업전 검수는 **구성품 줄마다 1장**이고, 「검수완료」 허용 조건이 `missingSlots` 하나로
 * 판정된다 (db.completePreCheck). 여기가 틀리면 사진 없는 작업이 작업중이 되거나,
 * 다 찍었는데 완료가 막힌다.
 */
function checkPhotos(t) {
    const lines = 1 + pick(8);
    // LOT 행이 여러 개인 구성품을 섞는다 - 그래도 사진 슬롯은 줄마다 1개여야 한다
    const items = [];
    for (let line = 1; line <= lines; line += 1) {
        const rows = 1 + pick(3);
        for (let r = 0; r < rows; r += 1) items.push({ line_no: line, sort_order: r + 1 });
    }
    const want = photoLines(items);
    if (want.length !== lines || want.some((n, i) => n !== i + 1)) {
        note('P1', `t${t} 슬롯이 구성품 줄과 다르다 ${JSON.stringify(want)}`);
    }

    // 일부만 찍은 상태 - 없는 것만 정확히 집어내야 한다
    const shot = want.filter(() => rnd() < 0.6);
    const miss = missingSlots(want, shot);
    if (miss.some((n) => shot.includes(n)) || miss.some((n) => !want.includes(n))) {
        note('P2', `t${t} 빠진 슬롯 계산이 틀렸다 ${JSON.stringify({ want, shot, miss })}`);
    }
    if ((miss.length === 0) !== (shot.length === want.length)) {
        note('P2', `t${t} 다 찍었는지 판정이 어긋났다 ${JSON.stringify({ shot, miss })}`);
    }

    // 중복·문자열·구성품에 없는 줄이 섞여도 흔들리지 않는다 (앱은 슬롯 키를 문자열로 들고 있다)
    const noisy = shot.map(String).concat(shot, [999]);
    const same = missingSlots(want, noisy);
    if (JSON.stringify(same) !== JSON.stringify(miss)) {
        note('P3', `t${t} 잡음이 섞이자 결과가 달라졌다 ${JSON.stringify({ miss, same })}`);
    }
}

/* ------------------------------- 구성품 줄 묶기 ------------------------------- */

/**
 * `groupLines` 는 웹 상세·작업지시서와 앱 작업가이드가 **함께** 쓴다.
 * 여기가 틀리면 같은 작업의 구성품 표가 화면마다 다르게 보인다.
 */
function checkGroup(t) {
    // 줄 번호는 일부러 뒤섞어 넣는다 - 입력 순서와 무관하게 오름차순으로 나와야 한다
    const nos = [...new Set(Array.from({ length: 1 + pick(6) }, () => 1 + pick(9)))];
    const items = [];
    nos.forEach((no) => {
        const rows = 1 + pick(3);
        for (let r = 0; r < rows; r += 1) {
            items.push({
                line_no: no,
                kind: r === 0 ? '제품' : '부자재',      // 대표값은 첫 행에서만 와야 한다
                code: `C${no}-${r}`,
                name: `N${no}-${r}`,
                qty_per: 1 + pick(5),
                lot: `L${no}-${r}`,
            });
        }
    });
    // 입력 순서를 흔든다 (같은 줄의 행 순서는 유지된 채로 줄끼리만 섞이도록 하지 않는다 -
    // 실제 데이터도 sort_order 가 뒤섞여 들어올 수 있다)
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = pick(i + 1);
        [items[i], items[j]] = [items[j], items[i]];
    }

    const lines = groupLines(items);
    const flat = lines.flatMap((l) => l.rows);
    if (flat.length !== items.length || items.some((it) => !flat.includes(it))) {
        note('B1', `t${t} 행이 빠지거나 늘었다 ${flat.length} != ${items.length}`);
    }
    if (lines.some((l, i) => i > 0 && l.line_no <= lines[i - 1].line_no)) {
        note('B2', `t${t} 줄 순서가 오름차순이 아니다 ${JSON.stringify(lines.map((l) => l.line_no))}`);
    }
    lines.forEach((l) => {
        const own = items.filter((it) => it.line_no === l.line_no);
        const head = own[0];
        if (l.kind !== head.kind || l.code !== head.code
            || l.name !== head.name || l.qty_per !== head.qty_per) {
            note('B3', `t${t} 줄 ${l.line_no} 대표값이 첫 행과 다르다`);
        }
        if (l.rows.length !== own.length || l.rows.some((r, i) => r !== own[i])) {
            note('B3', `t${t} 줄 ${l.line_no} 의 행 순서가 입력과 다르다`);
        }
    });
    if (groupLines(null).length || groupLines([]).length) {
        note('B1', `t${t} 빈 입력이 빈 배열을 주지 않는다`);
    }
}

/* --------------------------------- 실행 --------------------------------- */

const total = Number(process.argv[2] ?? 3000);
for (let t = 0; t < total; t += 1) {
    checkCalendar(t);
    checkLots(t);
    checkDocNo(t);
    checkPhotos(t);
    checkGroup(t);
}

const bad = Object.values(fails).some(Boolean);
const lines = Object.entries(fails)
    .map(([k, v]) => `  ${k}: ${v}건${v ? `   예: ${first[k]}` : ''}`);
process.stdout.write(`유통가공 순수 계산 불변식 검사 (랜덤 ${total}회)\n${lines.join('\n')}\n`);
process.stdout.write(`${bad ? 'FAIL' : 'PASS'}\n`);
process.exitCode = bad ? 1 : 0;
