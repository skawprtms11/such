/**
 * 유통가공 - 작업캘린더 탭 (docs/processing.md §12).
 *
 * 월 달력(일~토 × 6주 = 42칸)에 작업을 **시작예정일 ~ 완료요청일** 막대로 그린다.
 * 🔑 배치 계산은 이 파일이 하지 않는다 - `processing-calc.calendarLanes()` 가 순수 함수로
 * 하고(`tools/processing-check.js` 가 불변식 C1~C5 를 센다), 여기서는 결과를 그리기만 한다.
 */
import * as db from '../../db.js';
import { WEEKDAYS } from '../../config.js';
import { CAL_MAX_LANE, calendarLanes } from '../../processing-calc.js';
import { esc, num, openModal, today } from '../../util.js';
import { openSafe, statusOptions, statusTag, statusTone } from './common.js';
import { openJobDetail } from './jobs.js';

/** `'YYYY-MM'` 에 개월을 더한다 */
function addMonth(month, diff) {
    const [y, m] = String(month).split('-').map(Number);
    const d = new Date(y, m - 1 + diff, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 작업캘린더 탭을 그린다 */
export async function drawCalendar({ state, body, user, reload }) {
    const month = state.month;
    const jobs = await db.listProcessJobs({ status: state.status });
    const { weeks } = calendarLanes(jobs, month, { maxLane: CAL_MAX_LANE });
    const byId = new Map(jobs.map((j) => [j.id, j]));

    body.innerHTML = `
<div class="toolbar">
  <label class="field" style="flex:0 0 130px">
    <span class="field__label">진행상태</span>
    <select id="pc-f-status">${statusOptions(state.status)}</select>
  </label>
  <div class="pc-nav">
    <button class="btn" id="pc-prev" type="button" aria-label="이전 달">◀</button>
    <strong class="pc-month">${esc(month)}</strong>
    <button class="btn" id="pc-next" type="button" aria-label="다음 달">▶</button>
    <button class="btn" id="pc-today" type="button">오늘</button>
  </div>
  <span class="toolbar__spacer"></span>
  <span class="pc-hint">막대는 시작예정일 ~ 완료요청일</span>
</div>
<div class="pc-cal">
  <div class="pc-cal__head">
    ${WEEKDAYS.map((w, i) => `<div class="pc-dow pc-dow--${i}">${esc(w)}</div>`).join('')}
  </div>
  ${weeks.map((week, wi) => weekHtml(week, wi, month, byId)).join('')}
</div>`;

    body.querySelector('#pc-prev').addEventListener('click', () => {
        state.month = addMonth(month, -1);
        reload();
    });
    body.querySelector('#pc-next').addEventListener('click', () => {
        state.month = addMonth(month, 1);
        reload();
    });
    body.querySelector('#pc-today').addEventListener('click', () => {
        state.month = today().slice(0, 7);
        reload();
    });
    body.querySelector('#pc-f-status').addEventListener('change', (e) => {
        state.status = e.target.value;
        reload();
    });

    body.querySelectorAll('[data-job]').forEach((el) => {
        el.addEventListener('click',
            () => openSafe(openJobDetail(el.dataset.job, user, reload)));
    });
    body.querySelectorAll('[data-more]').forEach((el) => {
        el.addEventListener('click', () => {
            const week = weeks[Number(el.dataset.week)];
            const at = Number(el.dataset.more);
            openDayList(week.days[at], week.hidden
                .filter((s) => s.colStart <= at && at < s.colStart + s.colSpan)
                .map((s) => byId.get(s.jobId))
                .filter(Boolean), user, reload);
        });
    });
}

/** 한 주 - 날짜 칸(배경) 위에 막대 격자를 겹친다 */
function weekHtml(week, wi, month, byId) {
    const bars = week.bars.map((b) => {
        const job = byId.get(b.jobId);
        if (!job) return '';
        const label = `${job.doc_no ? `${job.doc_no} ` : ''}${job.product_name}`;
        return `
<button class="pc-bar pc-bar--${statusTone(job.status)} ${b.startsHere ? 'is-start' : ''}
  ${b.endsHere ? 'is-end' : ''}" type="button" data-job="${esc(job.id)}"
  style="grid-column:${b.colStart + 1}/span ${b.colSpan};grid-row:${b.lane + 1}"
  title="${esc(`${label} (${job.start_date} ~ ${job.due_date})`)}">${esc(label)}</button>`;
    }).join('');

    const more = week.overflow.map((n, i) => (n ? `
<button class="pc-more" type="button" data-more="${i}" data-week="${wi}"
  style="grid-column:${i + 1};grid-row:${CAL_MAX_LANE + 1}">+${num(n)}</button>` : '')).join('');

    return `
<div class="pc-week">
  <div class="pc-week__bg">
    ${week.days.map((d, i) => `
    <div class="pc-cell ${d.slice(0, 7) === month ? '' : 'is-out'}
      ${d === today() ? 'is-today' : ''}">
      <span class="pc-date pc-dow--${i}">${Number(d.slice(8, 10))}</span>
    </div>`).join('')}
  </div>
  <div class="pc-week__bars" style="--pc-lanes:${CAL_MAX_LANE}">${bars}${more}</div>
</div>`;
}

/** `+N` 을 눌렀을 때 그 날짜에 숨은 작업 목록 */
function openDayList(date, jobs, user, reload) {
    const m = openModal(`${date} 작업`, `
<div class="table-wrap"><table class="grid">
  <thead><tr>
    <th>문서번호</th><th>제품코드</th><th>제품명</th>
    <th>기간</th><th class="center">진행상태</th>
  </tr></thead>
  <tbody>
    ${jobs.map((j) => `
    <tr class="is-clickable" data-open="${esc(j.id)}">
      <td>${esc(j.doc_no ?? '') || '-'}</td>
      <td>${esc(j.product_code)}</td>
      <td class="wrap"><span class="link">${esc(j.product_name)}</span></td>
      <td>${esc(j.start_date)} ~ ${esc(j.due_date)}</td>
      <td class="center">${statusTag(j.status)}</td>
    </tr>`).join('')}
  </tbody>
</table></div>`);

    m.body.querySelectorAll('[data-open]').forEach((tr) => {
        tr.addEventListener('click', () => {
            m.close();
            openSafe(openJobDetail(tr.dataset.open, user, reload));
        });
    });
}
