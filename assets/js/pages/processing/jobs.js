/**
 * 유통가공 - 작업현황 탭 (docs/processing.md §9 · §11).
 *
 * 목록·다중 선택·수정·삭제·작업지시서 생성이 여기 있다.
 * 🔑 진행상태는 `db.processStatus()` 가 계산해 각 행의 `status` 로 붙어 온다.
 * 화면은 그것을 **그리기만** 하고 `done_at`·`doc_created_at` 을 다시 해석하지 않는다.
 */
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { PROCESS_ITEM_KIND, PROCESS_PHASE, PROCESS_STATUS } from '../../config.js';
import { needQty } from '../../processing-calc.js';
import {
    confirmDialog, downloadCsv, esc, fmtDateTime, num, openModal, toast, today,
} from '../../util.js';
import { emptyRow, groupLines, kindTag, openSafe, statusOptions, statusTag } from './common.js';
import { printProcessDoc } from './doc.js';
import { openJobForm } from './jobform.js';

/** 목록에서 고른 작업 id (탭을 오가도 유지한다) */
const picked = new Set();

/** 작업현황 탭을 그린다 */
export async function drawJobs({ state, body, user, reload }) {
    const canManage = can(user, 'manageProcessing');
    const rows = await db.listProcessJobs({
        from: state.from,
        to: state.to,
        status: state.status,
        keyword: state.keyword,
    });
    // 목록에서 사라진 건은 선택에서도 뺀다 (남의 삭제·필터 변경으로 유령 선택이 남지 않게)
    const alive = new Set(rows.map((r) => r.id));
    [...picked].forEach((id) => { if (!alive.has(id)) picked.delete(id); });

    body.innerHTML = `
<div class="toolbar">
  <label class="field" style="flex:0 0 150px">
    <span class="field__label">시작예정일(부터)</span>
    <input type="date" id="pj-f-from" value="${esc(state.from)}">
  </label>
  <label class="field" style="flex:0 0 150px">
    <span class="field__label">시작예정일(까지)</span>
    <input type="date" id="pj-f-to" value="${esc(state.to)}">
  </label>
  <label class="field" style="flex:0 0 130px">
    <span class="field__label">진행상태</span>
    <select id="pj-f-status">${statusOptions(state.status)}</select>
  </label>
  <label class="field" style="flex:1 1 180px;max-width:240px">
    <span class="field__label">문서번호 / 제품</span>
    <input type="text" id="pj-f-kw" placeholder="검색어 입력" value="${esc(state.keyword)}">
  </label>
  <button class="btn" id="pj-search" type="button">조회</button>
  <span class="toolbar__spacer"></span>
  <div class="btn-row">
    ${can(user, 'download')
        ? '<button class="btn" id="pj-csv" type="button">다운로드</button>' : ''}
    ${canManage ? `
    <button class="btn" id="pj-edit" type="button">수정</button>
    <button class="btn btn--danger" id="pj-del" type="button">삭제</button>
    <button class="btn btn--primary" id="pj-new" type="button">작업등록</button>` : ''}
  </div>
</div>
<div class="table-wrap"><table class="grid" id="pj-tbl">
  <colgroup>
    <col style="width:40px"><col style="width:56px"><col style="width:130px">
    <col style="width:140px"><col><col style="width:90px">
    <col style="width:110px"><col style="width:110px">
    <col style="width:90px"><col style="width:110px">
  </colgroup>
  <thead><tr>
    <th class="center">${canManage
        ? `<input type="checkbox" id="pj-all" aria-label="전체 선택"
             ${rows.length && rows.every((j) => picked.has(j.id)) ? 'checked' : ''}>` : ''}</th>
    <th>연번</th><th>문서번호</th><th>제품코드</th><th>제품명</th><th class="num">작업수량</th>
    <th>시작예정일</th><th>완료요청일</th><th class="center">진행상태</th><th class="center">문서</th>
  </tr></thead>
  <tbody>
    ${rows.length ? rows.map((j, i) => rowHtml(j, i, canManage)).join('')
        : emptyRow(10, '등록된 유통가공 작업이 없습니다.')}
  </tbody>
</table></div>`;

    /** 필터 반영 후 다시 조회 */
    function applyFilter() {
        state.from = body.querySelector('#pj-f-from').value;
        state.to = body.querySelector('#pj-f-to').value;
        state.status = body.querySelector('#pj-f-status').value;
        state.keyword = body.querySelector('#pj-f-kw').value.trim();
        reload();
    }
    body.querySelector('#pj-search').addEventListener('click', applyFilter);
    body.querySelector('#pj-f-kw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyFilter();
    });

    body.querySelectorAll('[data-pick]').forEach((el) => {
        el.addEventListener('click', (e) => e.stopPropagation());
        el.addEventListener('change', () => {
            if (el.checked) picked.add(el.dataset.pick);
            else picked.delete(el.dataset.pick);
            const all = body.querySelector('#pj-all');
            if (all) all.checked = rows.length > 0 && rows.every((j) => picked.has(j.id));
        });
    });
    body.querySelector('#pj-all')?.addEventListener('change', (e) => {
        rows.forEach((j) => (e.target.checked ? picked.add(j.id) : picked.delete(j.id)));
        body.querySelectorAll('[data-pick]').forEach((el) => { el.checked = e.target.checked; });
    });

    body.querySelectorAll('[data-open]').forEach((el) => {
        el.addEventListener('click', () => openSafe(openJobDetail(el.dataset.open, user, reload)));
    });
    body.querySelectorAll('[data-doc]').forEach((el) => {
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            await handleDoc(el.dataset.doc, user, reload);
        });
    });

    body.querySelector('#pj-new')?.addEventListener('click', () => {
        openSafe(openJobForm(null, user, reload));
    });
    body.querySelector('#pj-edit')?.addEventListener('click', () => {
        if (picked.size !== 1) {
            toast('수정할 작업을 1건만 선택하세요.', 'error');
            return;
        }
        openSafe(db.getProcessJob([...picked][0])
            .then((found) => (found ? openJobForm(found, user, reload)
                : toast('작업을 찾을 수 없습니다.', 'error'))));
    });
    body.querySelector('#pj-del')?.addEventListener('click', () => {
        openSafe(deletePicked(rows, user, reload));
    });
    body.querySelector('#pj-csv')?.addEventListener('click', () => downloadJobs(rows));
}

/** 목록 한 행 */
function rowHtml(j, i, canManage) {
    // 완료요청일이 지났는데 끝나지 않았으면 빨갛게 알린다
    const late = j.status !== PROCESS_STATUS.DONE && j.due_date < today();
    return `
<tr data-id="${esc(j.id)}">
  <td class="center">${canManage ? `<input type="checkbox" data-pick="${esc(j.id)}"
    ${picked.has(j.id) ? 'checked' : ''} aria-label="선택">` : ''}</td>
  <td class="center">${num(i + 1)}</td>
  <td>${esc(j.doc_no ?? '') || '-'}</td>
  <td>${esc(j.product_code)}</td>
  <td class="wrap"><span class="link" data-open="${esc(j.id)}">${esc(j.product_name)}</span></td>
  <td class="num">${num(j.qty)}</td>
  <td>${esc(j.start_date)}</td>
  <td class="${late ? 'pc-late' : ''}">${esc(j.due_date)}</td>
  <td class="center">${statusTag(j.status)}</td>
  <td class="center"><button class="btn btn--sm ${j.doc_no ? '' : 'btn--primary'}"
      type="button" data-doc="${esc(j.id)}">${j.doc_no ? '보기' : '생성'}</button></td>
</tr>`;
}

/**
 * 문서생성 / 문서보기.
 * 🔑 번호가 없으면 채번하고, 있으면 그대로 다시 인쇄한다. **문서생성은 상태를 바꾸지 않는다**
 * (§8 개정 - 진행은 앱 작업전 검수로만 된다).
 * 재생성은 하지 않는다 - 같은 번호의 내용이 다른 종이가 두 장 돌면 현장 사고다.
 */
async function handleDoc(id, user, reload) {
    try {
        const before = await db.getProcessJob(id);
        if (!before) throw new Error('작업을 찾을 수 없습니다.');
        if (!before.job.doc_no) {
            if (!can(user, 'manageProcessing')) {
                throw new Error('작업지시서를 생성할 권한이 없습니다.');
            }
            if (!(await confirmDialog(
                '작업지시서를 생성할까요?\n생성하면 문서번호가 정해집니다.'
                + '\n이후에는 수량·구성품을 수정할 수 없습니다.'))) return;
            await db.issueProcessDoc(id, user);
        }
        const after = await db.getProcessJob(id);
        printProcessDoc(after.job, after.items);
        await reload();
    } catch (err) {
        toast(err.message, 'error');
    }
}

/** 선택한 작업 삭제 - 완료건이 섞여 있으면 db 가 전부 거부한다 */
async function deletePicked(rows, user, reload) {
    if (!picked.size) {
        toast('삭제할 작업을 선택하세요.', 'error');
        return;
    }
    const targets = rows.filter((j) => picked.has(j.id));
    const docs = targets.filter((j) => j.doc_no).map((j) => j.doc_no);
    const msg = `선택한 ${targets.length}건을 삭제할까요?`
        + (docs.length ? `\n작업지시서가 나간 건이 있습니다: ${docs.join(', ')}` : '');
    if (!(await confirmDialog(msg))) return;
    try {
        const n = await db.deleteProcessJobs([...picked], user);
        picked.clear();
        toast(`${n}건을 삭제했습니다.`, 'success');
        await reload();
    } catch (err) {
        toast(err.message, 'error');
    }
}

/** 목록 CSV 다운로드 */
function downloadJobs(rows) {
    downloadCsv(`유통가공작업_${today()}.csv`, [
        '문서번호', '작업구분', '제품코드', '제품명', '작업수량',
        '시작예정일', '완료요청일', '진행상태', '등록자', '등록일',
    ], rows.map((j) => [
        j.doc_no ?? '', j.work_type, j.product_code, j.product_name, j.qty,
        j.start_date, j.due_date, j.status, j.created_by_name,
        String(j.created_at).slice(0, 10),
    ]));
}

/** 상세 팝업의 구성품 표 */
function detailItemsHtml(job, items) {
    return groupLines(items).map((line) => line.rows.map((r, i) => {
        const head = i === 0;
        const need = needQty(line.qty_per, job.qty);
        return `
<tr>
  <td>${head ? kindTag(line.kind) : ''}</td>
  <td>${head ? esc(line.code) : ''}</td>
  <td class="wrap">${head ? esc(line.name) : ''}</td>
  <td class="num">${head ? num(need) : ''}</td>
  <td>${line.kind === PROCESS_ITEM_KIND.PRODUCT ? esc(r.lot || '-') : '—'}</td>
  <td class="num">${num(r.qty)}</td>
</tr>`;
    }).join('')).join('');
}

/**
 * 작업 상세 팝업 (목록의 제품명 · 캘린더의 막대가 **같은 함수**를 부른다).
 * 화면마다 따로 짜면 보이는 내용이 갈린다.
 */
export async function openJobDetail(jobId, user, reload) {
    const found = await db.getProcessJob(jobId);
    if (!found) {
        toast('작업을 찾을 수 없습니다.', 'error');
        return;
    }
    const { job, items } = found;
    const canManage = can(user, 'manageProcessing');
    const photos = await loadPhotos(job.id);

    const m = openModal(`${job.product_code} · ${job.product_name}`, `
<table class="grid pc-detail">
  <tr><th>문서번호</th><td>${esc(job.doc_no ?? '') || '-'}</td>
      <th>진행상태</th><td>${statusTag(job.status)}</td></tr>
  <tr><th>작업구분</th><td>${esc(job.work_type)}</td>
      <th>작업수량</th><td>${num(job.qty)}</td></tr>
  <tr><th>시작예정일</th><td>${esc(job.start_date)}</td>
      <th>완료요청일</th><td>${esc(job.due_date)}</td></tr>
  <tr><th>등록자</th><td>${esc(job.created_by_name)}</td>
      <th>등록일</th><td>${esc(String(job.created_at).slice(0, 10))}</td></tr>
  <tr><th>작업전 검수</th><td>${checkedCell(job.pre_check_by_name, job.pre_check_at)}</td>
      <th>완료 검수</th><td>${checkedCell(job.done_by_name, job.done_at)}</td></tr>
</table>
${photosHtml(photos)}
<div class="pc-sec">
  <div class="pc-sec__head"><h4>구성품</h4></div>
  <div class="table-wrap"><table class="grid pc-items">
    <colgroup>
      <col style="width:86px"><col style="width:140px"><col>
      <col style="width:100px"><col style="width:150px"><col style="width:100px">
    </colgroup>
    <thead><tr>
      <th>구분</th><th>제품코드</th><th>품명</th><th class="num">필요수량</th>
      <th>LOT</th><th class="num">수량</th>
    </tr></thead>
    <tbody>${detailItemsHtml(job, items)}</tbody>
  </table></div>
</div>`, {
        wide: true,
        footer: `
${canManage ? '<button class="btn" id="pd-edit" type="button">수정</button>' : ''}
<span class="toolbar__spacer"></span>
<button class="btn btn--primary" id="pd-doc" type="button">${job.doc_no ? '작업지시서' : '문서생성'}</button>
<button class="btn" id="pd-close" type="button">닫기</button>`,
    });

    // 🔑 사진 주소는 화면을 닫을 때 반드시 놓는다 (mock 의 objectURL 은 안 놓으면 샌다).
    // `openModal` 이 스스로 닫는 두 경로(× 버튼 · 배경 클릭)도 같이 받는다 - `release()` 는
    // 여러 번 불러도 안전하다
    const close = () => {
        photos.release();
        m.close();
    };
    m.root.addEventListener('click', (e) => {
        if (e.target === m.root || e.target.closest('.modal__close')) photos.release();
    });
    m.root.querySelector('#pd-close').addEventListener('click', close);
    m.root.querySelector('#pd-edit')?.addEventListener('click', () => {
        close();
        openSafe(openJobForm(found, user, reload));
    });
    m.root.querySelector('#pd-doc').addEventListener('click', async () => {
        close();
        await handleDoc(job.id, user, reload);
    });
    // 주소는 **누르는 순간** 다시 읽는다. 아래 재발급으로 바뀌어 있을 수 있다
    m.root.querySelectorAll('button[data-path]').forEach((el) => {
        el.addEventListener('click', () => openPhoto(photos.urls.get(el.dataset.path),
            el.dataset.cap));
    });
    bindPhotoRetry(m.root, photos);
}

/**
 * 서명 URL 은 10분이면 만료된다 (`store.js` 의 `fileUrls`).
 * 팝업을 오래 열어 두면 썸네일이 깨지므로, **깨진 그림만** 한 번 다시 발급받아 갈아 끼운다.
 * 팝업을 열 때마다 새로 발급하므로 이 경로는 오래 열어 둔 경우에만 탄다.
 */
function bindPhotoRetry(root, photos) {
    root.querySelectorAll('img[data-path]').forEach((img) => {
        img.addEventListener('error', async () => {
            if (img.dataset.retried) return;
            img.dataset.retried = '1';
            try {
                const url = await photos.reissue(img.dataset.path);
                if (url) img.src = url;
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/**
 * 검수 사진 메타 + 주소.
 * 앱이 남긴 증빙을 **보여주기만** 한다 - 웹에서는 찍지도 지우지도 않는다 (§8 · A16).
 */
async function loadPhotos(jobId) {
    const [pre, done] = await Promise.all([
        db.listProcessPhotos(jobId, PROCESS_PHASE.PRE),
        db.listProcessPhotos(jobId, PROCESS_PHASE.DONE),
    ]);
    const rows = [...pre, ...done];
    const packs = [await db.processPhotoUrls(rows.map((p) => p.path))];
    const urls = packs[0].urls;
    return {
        pre,
        done,
        urls,
        /** 만료된 주소 1건 다시 발급 (`bindPhotoRetry`) - 새로 받은 몫도 함께 놓는다 */
        async reissue(path) {
            const next = await db.processPhotoUrls([path]);
            packs.push(next);
            const url = next.urls.get(path);
            if (url) urls.set(path, url);
            return url;
        },
        release() {
            packs.splice(0).forEach((pack) => pack.release());
        },
    };
}

/** 검수자·검수시각 칸 */
function checkedCell(name, at) {
    if (!at) return '-';
    return `${esc(name || '')} · ${esc(fmtDateTime(at))}`;
}

/** 썸네일 한 칸 - 주소를 못 받은 사진(파일이 사라짐)도 자리는 남긴다 */
function thumbHtml(url, cap, path) {
    if (!url) return `<span class="pc-thumb is-gone"><span>${esc(cap)} (없음)</span></span>`;
    return `
<button class="pc-thumb" type="button" data-path="${esc(path)}" data-cap="${esc(cap)}">
  <img src="${esc(url)}" alt="${esc(cap)}" data-path="${esc(path)}">
  <span>${esc(cap)}</span></button>`;
}

/** 사진 묶음 한 절 */
function photoSecHtml(rows, urls, title, capOf) {
    if (!rows.length) return '';
    return `
<div class="pc-sec">
  <div class="pc-sec__head">
    <h4>${esc(title)} <span class="tag tag--gray">${rows.length}장</span></h4>
  </div>
  <div class="pc-thumbs">
    ${rows.map((p) => thumbHtml(urls.get(p.path), capOf(p), p.path)).join('')}
  </div>
</div>`;
}

/** 사진 썸네일 줄 (작업전 N장 · 완료 3장) */
function photosHtml({ pre, done, urls }) {
    return photoSecHtml(pre, urls, '작업전 검수 사진', (p) => `구성품 ${p.line_no}`)
        + photoSecHtml(done, urls, '완료 검수 사진', (p) => `완료 ${p.seq}`);
}

/** 썸네일을 눌렀을 때 원본 크기로 */
function openPhoto(url, cap) {
    if (!url) {
        toast('사진 주소를 받지 못했습니다. 팝업을 닫았다가 다시 열어 주세요.', 'error');
        return;
    }
    openModal(cap, `<div class="pc-photo"><img src="${esc(url)}" alt="${esc(cap)}"></div>`, {
        wide: true,
    });
}
