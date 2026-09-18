/**
 * 업무프로세스 (모바일 앱 · 보기 전용).
 *
 *   #/process   업무구분 → 업무항목을 고르면 그 흐름을 세로 스테퍼(플로우차트)로 보여 준다
 *
 * 현장에서 매뉴얼을 펼쳐 보는 화면이다. 편집은 웹(업무프로세스 탭)에서만 한다.
 *
 * 🔑 **흐름은 `db.processFlow` 하나만 읽는다** - 번호(`no`)·층(`layer`)·다음 단계(`nexts`)를
 * 앱이 다시 계산하지 않는다 (웹 도식과 같은 값이라 번호가 어긋나지 않는다).
 *
 * 🔑 **앱은 도식을 그리지 않는다.** 같은 층에 단계가 여럿이면(갈래) 세로 스테퍼 안에서
 * 「4.1 국내」 머리를 붙인 하위 스테퍼로 펴고, 갈래 끝에 「↩ 갈래가 다시 ⑦ … 로 모입니다」
 * 캡션 한 줄만 붙인다 (좌표·선은 웹 업무프로세스 탭에만 있다).
 *
 * 🔑 **체크항목은 나오지 않는다** - 여기는 흐름 매뉴얼이고, 체크는 `#/checklist` 가 맡는다
 * (웹 업무프로세스 탭과 같은 기준 · docs/checklist.md).
 */
import * as db from '../../db.js';
import { CHECK_KIND } from '../../config.js';
import { esc } from '../../util.js';
import { emptyState, segment, pollGuard } from '../ui.js';

/** 보고 있던 업무구분·업무항목을 기억한다 */
const state = { division: null, group: null };

/** 캡션용 번호 - 정수는 `3.`, 갈래 줄의 점 번호는 `4.1` 그대로 */
function noText(no) {
    return /^\d+$/.test(String(no)) ? `${no}.` : String(no);
}

/**
 * 스테퍼 동글 - 정수만 적는다. 갈래 줄은 머리(`4.1 국내`)가 번호를 가지므로 가운뎃점만 찍는다
 * (번호를 두 번 적으면 좁은 화면에서 줄이 길어진다).
 */
function badgeNo(no) {
    return /^\d+$/.test(String(no)) ? String(no) : '·';
}

export async function render(root) {
    root.innerHTML = `
<div id="pick-div"></div>
<div id="pick-grp"></div>
<div id="flow"></div>`;
    const divHost = root.querySelector('#pick-div');
    const grpHost = root.querySelector('#pick-grp');
    const flowEl = root.querySelector('#flow');
    let divSeg = null;
    let grpSeg = null;

    async function reload() {
        const divisions = (await db.listChecklistDivisions()).filter((d) => d.active);
        if (!divisions.some((d) => d.id === state.division)) {
            state.division = divisions[0]?.id ?? null;
        }
        divSeg?.destroy();
        divSeg = null;
        if (divisions.length) {
            divSeg = segment(divHost, divisions.map((d) => ({ key: d.id, label: d.title })),
                state.division, (key) => {
                    state.division = key;
                    state.group = null;
                    reload();
                });
        }

        const groups = state.division
            ? (await db.listChecklistGroups(state.division)).filter((g) => g.active)
            : [];
        if (!groups.some((g) => g.id === state.group)) state.group = groups[0]?.id ?? null;
        grpSeg?.destroy();
        grpSeg = null;
        if (groups.length) {
            grpSeg = segment(grpHost, groups.map((g) => ({ key: g.id, label: g.title })),
                state.group, (key) => {
                    state.group = key;
                    reload();
                });
        }

        const division = divisions.find((d) => d.id === state.division);
        const group = groups.find((g) => g.id === state.group);
        if (!group) {
            flowEl.innerHTML = emptyState(divisions.length
                ? '이 업무구분에 업무항목이 없습니다.' : '등록된 업무프로세스가 없습니다.');
            return;
        }
        const rows = await db.listChecklistItems({ root: group.id });
        const flow = await db.processFlow(group.id);
        flowEl.innerHTML = flowHtml(division, group, flow, rows);
    }

    await reload();
    return db.subscribe(pollGuard(root, reload), 15000);
}

/** 그 항목의 자식 (등록 순서) */
function kidsOf(rows, id) {
    return rows.filter((r) => r.parent_id === id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** 층별로 묶은 단계 - 층에 둘 이상이면 갈래다 */
function layersOf(flow) {
    const out = [];
    flow.nodes.forEach((n) => {
        const lv = flow.layer[n.id];
        const last = out[out.length - 1];
        if (last && last.lv === lv) last.items.push(n);
        else out.push({ lv, items: [n] });
    });
    return out;
}

/** 그 단계로 들어오는 간선의 조건 라벨 (갈래 머리에 「· 수출 건일 때」 로 붙는다) */
function labelOf(flow, id) {
    return flow.edges.filter((e) => e.to_id === id && e.label)
        .map((e) => e.label).join(' / ');
}

/**
 * 갈래가 다시 모이는 단계 🔑 - 갈래 멤버 **모두의 다음 단계**에 들어 있는 첫 단계.
 * 간선으로 표현된 합류를 캡션 한 줄로 읽어 주는 것이라 판정은 `nexts` 만 본다.
 */
function joinOf(flow, items) {
    const lists = items.map((n) => flow.nexts[n.id] ?? []);
    if (lists.length < 2) return null;
    return lists[0].find((id) => lists.every((l) => l.includes(id))) ?? null;
}

/** 단계 캡션 - `⑦ 출고완료` 대신 앱에서는 `7. 출고완료` 꼴 */
function caption(flow, id) {
    const node = flow.nodes.find((n) => n.id === id);
    return node ? `${noText(flow.no[id])} ${esc(node.title)}` : '';
}

/** 업무항목 한 벌의 흐름 */
function flowHtml(division, group, flow, rows) {
    if (!flow.nodes.length) return emptyState('아직 프로세스가 없습니다.');
    const layers = layersOf(flow);
    return `
<div class="m-fc">
  <p class="m-fc__crumb">${esc(division?.title ?? '')} › ${esc(group.title)}
    ${group.description ? ` · ${esc(group.description)}` : ''}</p>
  ${flow.cyclic ? '<p class="m-fc__merge">흐름이 되돌아옵니다 (웹에서 연결을 고쳐 주세요)</p>' : ''}
  <span class="m-fc__term">시작</span>
  ${layers.map((row) => layerHtml(row, flow, rows)).join('')}
  <div class="m-fc__line"></div>
  <span class="m-fc__term">완료</span>
</div>`;
}

/** 층 하나 - 단계 1개면 그대로, 여럿이면 갈래 블록 */
function layerHtml(row, flow, rows) {
    if (row.items.length === 1) {
        return `
  <div class="m-fc__line"></div>
  ${stepHtml(row.items[0], flow, rows)}`;
    }
    const join = joinOf(flow, row.items);
    return `
  <div class="m-fc__line"></div>
  <div class="m-fc__fork">
    ${row.items.map((n) => {
        const label = labelOf(flow, n.id);
        return `
    <p class="m-fc__fork-head">${esc(String(flow.no[n.id]))} ${esc(n.title)}${label ? ` · ${esc(label)}` : ''}</p>
    ${stepHtml(n, flow, rows)}`;
    }).join('')}
    ${join ? `<p class="m-fc__merge">↩ 갈래가 다시 ${caption(flow, join)} 로 모입니다</p>` : ''}
  </div>`;
}

/** 프로세스 한 단계 - 설명·담당·상황 블록 (체크항목은 여기에 없다) */
function stepHtml(item, flow, rows) {
    const sits = kidsOf(rows, item.id).filter((c) => c.kind === CHECK_KIND.SITUATION);
    const next = (flow.nexts[item.id] ?? [])[0] ?? null;
    return `
<div class="m-fc__step">
  <span class="m-fc__no">${badgeNo(flow.no[item.id])}</span>
  <span class="m-fc__text">
    <span class="m-fc__title">${esc(item.title)}</span>
    ${item.description ? `<span class="m-fc__desc">${esc(item.description)}</span>` : ''}
    ${whoText(item)}
  </span>
</div>
${sits.map((s) => sitHtml(s, rows, next ? caption(flow, next) : '')).join('')}`;
}

/** 담당 한 줄 - 정담당자 · 부담당자 */
function whoText(item) {
    const subs = item.sub_assignees ?? [];
    if (!item.assignee_name && !subs.length) return '';
    return `<span class="m-fc__desc">담당 ${esc(item.assignee_name)}${subs.length
        ? ` · 부 ${esc(subs.map((s) => s.name).join(', '))}` : ''}</span>`;
}

/**
 * 상황 블록 - 「X 발생 시」 → 대응 단계 → 처리 후 다음 단계.
 * 상황 아래 대응 프로세스는 간선이 아니라 트리 사슬이라 번호가 `1 2 3` 이다 (웹과 같다).
 */
function sitHtml(item, rows, nextText) {
    const subs = kidsOf(rows, item.id).filter((c) => c.kind === CHECK_KIND.PROCESS);
    return `
<div class="m-fc__sit">
  <div class="m-fc__sit-head">${esc(item.title)} 발생 시</div>
  ${item.description ? `<div class="m-fc__desc">${esc(item.description)}</div>` : ''}
  ${subs.length ? `<div class="m-fc__sub">${subs.map((s, i) => chainHtml(s, rows, i + 1)).join('')}</div>`
        : '<div class="m-fc__desc">대응 절차 없음 · 발생 내용만 기록</div>'}
  <div class="m-fc__merge">↩ 처리 후 ${nextText ? `${nextText} 로 이어감` : '흐름 마침'}</div>
</div>`;
}

/** 상황 아래 대응 단계 한 줄 (사슬 · 번호는 i+1) */
function chainHtml(item, rows, no) {
    const subs = kidsOf(rows, item.id).filter((c) => c.kind === CHECK_KIND.PROCESS);
    return `
${no > 1 ? '<div class="m-fc__line"></div>' : ''}
<div class="m-fc__step">
  <span class="m-fc__no">${no}</span>
  <span class="m-fc__text">
    <span class="m-fc__title">${esc(item.title)}</span>
    ${item.description ? `<span class="m-fc__desc">${esc(item.description)}</span>` : ''}
    ${whoText(item)}
    ${subs.length ? `<div class="m-fc__sub">${subs.map((s, i) => chainHtml(s, rows, i + 1)).join('')}</div>` : ''}
  </span>
</div>`;
}
