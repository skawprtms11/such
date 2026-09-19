/**
 * 유통가공 작업지시서 인쇄 (docs/processing.md §15).
 *
 * `status.js` 의 상차라벨과 **같은 방식**이다 - 새 창에 완결된 HTML 을 써 넣고 `window.print()`.
 * 인쇄 전용 창이라 앱 CSS 를 쓰지 않으므로 필요한 스타일을 문서 안에 담는다.
 *
 * 🔑 제품명·품목명·LOT 은 사용자 입력이라 **모든 값을 `esc()`** 로 내보낸다.
 */
import { code128Svg } from '../../barcode.js';
import { PROCESS_ITEM_KIND } from '../../config.js';
import { needQty } from '../../processing-calc.js';
import { esc, num, today, toast } from '../../util.js';
import { groupLines } from './common.js';

/** 작업지시서를 새 창에 그리고 인쇄 대화상자를 띄운다 */
export function printProcessDoc(job, items) {
    if (!job) return;
    const win = window.open('', '_blank', 'width=900,height=1100');
    if (!win) {
        toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.', 'error');
        return;
    }
    win.document.write(docHtml(job, items));
    win.document.close();
    win.focus();
}

/** 구성품 표의 한 행 - 같은 구성품 줄의 두 번째 행부터는 앞 칸을 비운다 */
function itemRows(items, jobQty) {
    return groupLines(items).map((line) => line.rows.map((r, i) => {
        const head = i === 0;
        const need = needQty(line.qty_per, jobQty);
        const lot = line.kind === PROCESS_ITEM_KIND.PRODUCT ? (r.lot || '-') : '—';
        return `
      <tr>
        <td>${head ? esc(line.kind) : ''}</td>
        <td>${head ? esc(line.code) : ''}</td>
        <td>${head ? esc(line.name) : ''}</td>
        <td class="num">${head ? num(need) : ''}</td>
        <td>${esc(lot)}</td>
        <td class="num">${num(r.qty)}</td>
      </tr>`;
    }).join('')).join('');
}

/** 작업지시서 A4 인쇄용 HTML (export 는 검사 스크립트용) */
export function docHtml(job, items) {
    const info = [
        ['작업구분', job.work_type, '제품코드', job.product_code],
        ['제품명', job.product_name, '작업수량', `${num(job.qty)} 개`],
        ['시작예정일', job.start_date, '완료요청일', job.due_date],
    ];
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>유통가공 작업지시서 ${esc(job.doc_no ?? '')}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; font-size: 11pt; line-height: 1.5;
    font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
  }
  /* 🔑 문서 맨 위의 바코드 띠 - 현장이 앱에서 스캔해 검수 화면을 여는 바코드다
     (docs/processing.md §17-1). 접힌 문서에서도 바로 보이게 제목보다 위에 크게 둔다 */
  .bcband {
    display: flex; flex-direction: column; align-items: center; gap: 1mm;
    padding: 3mm 0 4mm; border-bottom: 1px solid #000; margin-bottom: 5mm;
  }
  /* 가로는 인쇄 폭을 꽉 채우고 세로는 고정한다 (preserveAspectRatio=none - 모듈이 같은 배율로
     늘어나므로 바코드 규격은 유지된다). 스캔 거리가 멀어도 읽히게 가능한 한 크게 */
  .bcband svg { display: block; width: 100%; height: 28mm; }
  .bcband .no { font-size: 18pt; font-weight: 700; letter-spacing: 4px; font-family: monospace; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; }
  .head h1 { margin: 0; font-size: 20pt; letter-spacing: 2px; }
  .head .meta { text-align: right; font-size: 11pt; }
  .head .meta b { font-size: 14pt; letter-spacing: 1px; }
  hr { border: none; border-top: 2px solid #000; margin: 6mm 0; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 2.5mm 3mm; word-break: break-all; }
  th { background: #eee; text-align: left; font-weight: 700; }
  .info th { width: 26mm; white-space: nowrap; }
  .items { margin-top: 5mm; }
  .items thead th { text-align: center; }
  .num { text-align: right; }
  .sign { margin-top: 10mm; }
  .sign td { height: 22mm; vertical-align: top; }
  .sign th { width: 28mm; vertical-align: middle; }
</style></head>
<body onload="window.print()">
  ${job.doc_no ? `<div class="bcband">
    ${code128Svg(job.doc_no, { height: 60, moduleWidth: 2, showText: false })
        .replace('<svg ', '<svg preserveAspectRatio="none" ')}
    <div class="no">${esc(job.doc_no)}</div>
  </div>` : ''}
  <div class="head">
    <h1>유통가공 작업지시서</h1>
    <div class="meta">
      문서번호 <b>${esc(job.doc_no ?? '-')}</b><br>
      출력일 ${esc(today())}
    </div>
  </div>
  <hr>
  <table class="info">
    ${info.map(([k1, v1, k2, v2]) => `
    <tr><th>${esc(k1)}</th><td>${esc(v1)}</td><th>${esc(k2)}</th><td>${esc(v2)}</td></tr>`).join('')}
  </table>
  <table class="items">
    <colgroup>
      <col style="width:16mm"><col style="width:28mm"><col>
      <col style="width:22mm"><col style="width:32mm"><col style="width:22mm">
    </colgroup>
    <thead>
      <tr><th>구분</th><th>코드</th><th>품명</th><th>필요수량</th><th>LOT</th><th>수량</th></tr>
    </thead>
    <tbody>${itemRows(items, job.qty)}</tbody>
  </table>
  <table class="sign">
    <tr><th>작업자 서명</th><td></td><th>확인자 서명</th><td></td></tr>
  </table>
</body></html>`;
}
