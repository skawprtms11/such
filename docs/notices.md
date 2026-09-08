# 공지사항

> 코드 `assets/js/pages/notices.js`(웹) · `assets/js/mobile/screens/notices.js`(앱)
> 라우트 `#/notices` · [공통 규약](common.md) · [CLAUDE.md](../CLAUDE.md)

화주와 물류사 전체에 알릴 내용을 게시판 형태로 올리고, 댓글로 문답하는 화면.
이슈등록이 **개별 건의 문제 제기**라면, 공지사항은 **전체 대상 일방 안내**다.

댓글 · 대댓글의 동작과 마크업은 [이슈등록의 댓글](issues.md#댓글)을 그대로 본떴다.
같은 규칙을 두 벌 만들지 않으려고 클래스(`.comment*` · `.m-comment*`)까지 재사용한다.

---

## 접근 권한

| 역할 | 조회 | 등록·수정·삭제 | 댓글 등록 | 댓글 수정·삭제 |
|---|:---:|:---:|:---:|:---:|
| 관리자 | ✅ | ✅ | ✅ | ✅ (전체) |
| 용마담당자 | ✅ | ✅ | ✅ | 본인 것만 |
| 화주관리자 | ✅ | ❌ | ✅ | 본인 것만 |
| 화주영업팀 | ✅ | ❌ | ✅ | 본인 것만 |
| 현장작업자 | ✅ | ❌ | ✅ | 본인 것만 |

- **조회는 로그인 사용자 모두**다. `viewAll` 을 보지 않는다 — 공지는 전체 공개이므로
  화주영업팀도 남이 올린 공지를 본다 (다른 화면의 `createdBy` 필터를 걸지 않는다)
- **댓글 등록도 모두**가 할 수 있다. 현장작업자도 포함이다
- 등록·수정·삭제 권한은 `config.js` 의 `PERMISSION` 에 있는 **`manageNotice`** 다.
  화면은 `can(user, 'manageNotice')`(웹) · `db.canManageNotice(user)`(앱)으로만 판정하고
  역할명을 직접 비교하지 않는다
- 댓글 수정·삭제 판정은 `db.canEditNoticeComment(user, comment)` 한 곳에 있다
  (작성자 본인 `created_by === user.id` 또는 `manageUsers` 권한 = 관리자)
- 서버 RLS 도 같은 기준이다 (`supabase/schema.sql` 의 `can_manage_notice()`)

---

## 화면 구성 (웹)

### 목록

| 컬럼 | 폭 | 비고 |
|---|---|---|
| 연번 | 56px | 표시 순서. **중요공지는 `-`** (연번을 매기지 않는다) |
| 제목 | 남는 폭 전부 | 중요공지는 앞에 `중요` 빨강 배지. 클릭 시 상세 팝업 |
| 작성자 | 120px | `created_by_name` |
| 작성일 | 110px | 날짜만 (`YYYY-MM-DD`) |
| 댓글 | 80px | 삭제되지 않은 댓글 수. 없으면 `-` |

정렬은 **중요공지 먼저, 그 안에서 최신순**이다 (`db.listNotices()`).
중요공지 행에는 `.is-important` 가 붙어 노란 배경 + 굵은 글씨로 강조된다.

상단 필터는 `제목 / 내용` 검색어 하나다. 등록 버튼은 `manageNotice` 권한자에게만 나온다.

### 상세 팝업

제목(모달 헤더) · 작성자 · 작성일시(`수정됨` 표시) · `중요` 배지 · 본문 · 댓글.
본문은 `white-space: pre-wrap` 이라 줄바꿈이 그대로 보인다.

권한자에게는 메타 줄 오른쪽에 **수정 · 삭제 아이콘**이 붙는다.

### 등록 · 수정 폼

| 항목 | 필드 | 필수 |
|---|---|:---:|
| 제목 | `title` | ✅ |
| 내용 | `content` (textarea) | ✅ |
| 중요공지 | `important` (체크박스) | |

중요공지를 체크하면 목록 맨 위에 고정된다.

### 아이콘 버튼 🔑

**수정 · 저장 · 취소 · 삭제 · 답글은 문구 대신 아이콘**이다
(`icons.js` 의 `edit` `save` `close` `trash` `reply`).
아이콘만 두면 무슨 버튼인지 알 수 없으므로 **`aria-label` 과 `title` 을 반드시 붙인다**
(`iconBtn()` 헬퍼가 담당한다). 이모지는 쓰지 않는다.

---

## 화면 구성 (앱 `m.html`)

상단바 메뉴(`≡`)의 `공지사항`. **최소 구현**이다 — 검색 · 카드 목록 → 상세 시트(본문 + 댓글).

- 카드에는 제목 · `중요` 배지 · 작성자 · 등록일(`08/31`) · 댓글 수만 둔다
- 등록은 하단 독(`dock`)의 `공지 등록` 버튼 — 권한이 없으면 독 자체를 만들지 않는다
- 수정 · 삭제는 상세 시트 안의 아이콘 버튼
- 웹과 **같은 판정 함수**(`db.canManageNotice` · `db.canEditNoticeComment`)를 쓴다

---

## 댓글

`notice_comments` 테이블. 이슈 댓글과 규칙이 같고 **수정·삭제 주체만 넓다.**

| | 이슈 댓글 | 공지 댓글 |
|---|---|---|
| 등록 | 이슈를 볼 수 있는 사람 | **로그인 사용자 모두** |
| 수정·삭제 | 작성자 본인만 | **작성자 본인 또는 관리자** |

- `답글` 로 대댓글을 깊이 제한 없이 이어 단다 (`parent_id`).
  들여쓰기는 웹 5단 · 앱 3단까지만 준다
- 수정은 **인라인 편집**이다. 댓글 아래 슬롯(`[data-slot]`)에 입력칸이 열리고
  저장/취소 아이콘으로 끝낸다
- 수정하면 `updated_at` 이 남아 **(수정됨)** 으로 표시된다
- 삭제는 확인 대화상자를 거친다. **답글이 달린 댓글은 `deleted_at` 만 찍고
  `삭제된 댓글입니다` 로 남긴다**(soft delete). 답글이 없으면 행 자체를 지운다

---

## 상태

이슈처럼 절차·상태 전이가 **없다.** 남는 시각 필드는 셋뿐이다.

| 필드 | 뜻 |
|---|---|
| `created_at` | 등록 시각 |
| `updated_at` | 수정 시각 (있으면 `수정됨`) |
| `deleted_at` | 삭제 시각. **행을 지우지 않는다**(soft delete) |

🔑 **게시글 삭제도 soft delete 다.** 달려 있던 댓글 스레드를 남기고, 실수로 지운 뒤
DB 에서 되살릴 수 있게 하기 위해서다. `listNotices()` · `getNotice()` 가 `deleted_at`
있는 건을 걸러 내므로 화면에서는 보이지 않는다.

---

## db 함수

| 함수 | 설명 |
|---|---|
| `listNotices({keyword})` | 중요공지 우선 + 최신순. 삭제건 제외. 표시용 `comment_count` 를 붙인다 |
| `getNotice(id)` | 1건 조회 (삭제건은 `null`) |
| `createNotice(payload, user)` | `manageNotice` 검사 + 제목·내용 필수 검사 |
| `updateNotice(id, patch, user)` | 같은 검사 + `updated_at` 기록 |
| `deleteNotice(id, user)` | `deleted_at` 기록 (soft delete) |
| `canManageNotice(user)` | 등록·수정·삭제 권한 판정 (화면 버튼 노출과 같은 함수) |
| `listNoticeComments(noticeId)` | 등록순. 트리는 화면이 `parent_id` 로 만든다 |
| `addNoticeComment(noticeId, parentId, content, user)` | 로그인 사용자 모두 |
| `updateNoticeComment(id, content, user)` | 본인 또는 관리자. `updated_at` 기록 |
| `deleteNoticeComment(id, user)` | 답글 있으면 soft delete, 없으면 행 삭제 |
| `canEditNoticeComment(user, comment)` | 댓글 수정·삭제 권한 판정 |

`comment_count` 는 **저장 컬럼이 아니다.** `store.js` 의 화이트리스트에 없으므로
서버로 나가지 않는다 (이슈 목록의 `creator_name` 과 같은 방식).

---

## 실시간 갱신

웹 `db.subscribe(reload)` 5초 · 앱 `db.subscribe(pollGuard(root, reload), 8000)`.
Supabase 모드에서는 `notices` `notice_comments` 두 테이블이 Realtime publication 에 있다.

---

## 수정 시 주의

- 조회 권한을 좁히지 않는다. 공지는 전체 공개다 (`viewAll` 을 보지 않는 유일한 목록 화면)
- 댓글 등록 권한도 좁히지 않는다. 현장작업자도 써야 한다
- 등록·수정·삭제 판정을 화면에 흩지 않는다. `canManageNotice` / `canEditNoticeComment`
  두 함수만 고치면 웹·앱·서버가 함께 따라오게 되어 있다
- 게시글·댓글 삭제를 실삭제로 바꾸지 않는다. 스레드가 끊긴다
- 버튼에 이모지를 쓰지 않는다. `icons.js` 의 단색 라인 SVG + `aria-label` 이다
