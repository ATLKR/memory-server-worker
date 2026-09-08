export type Brand = {
  name: string;
  shortName: string;
  description: string;
  supportEmail: string;
  accentColor: string;
};

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Static shell only. Authenticated data is loaded through same-origin APIs. */
export function renderPage(brand: Brand): string {
  const name = escapeHtml(brand.name);
  const shortName = escapeHtml(brand.shortName);
  const description = escapeHtml(brand.description);
  const support = escapeHtml(brand.supportEmail);
  const supportHref = escapeHtml('mailto:' + encodeURIComponent(brand.supportEmail));
  const mark = escapeHtml(Array.from(brand.shortName)[0] ?? '');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}"><meta name="color-scheme" content="light">
<title>${name}</title><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js" defer></script></head>
<body><a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
<div id="boot" class="boot" role="status"><span class="brand-mark" aria-hidden="true">${mark}</span><p>작업 공간을 불러오고 있어요.</p></div>
<section id="welcome" class="welcome" hidden aria-labelledby="welcome-title">
  <header class="welcome-header"><a class="brand" href="/" aria-label="${name} 홈"><span class="brand-mark" aria-hidden="true">${mark}</span><span>${shortName}</span></a><span class="badge">Standard</span></header>
  <div class="welcome-grid"><div class="welcome-copy"><p class="eyebrow">A PLACE FOR WHAT MATTERS</p><h1 id="welcome-title">기억은 남기고,<br>다음 일에 집중하세요.</h1><p class="welcome-description">${description}</p><p class="welcome-subtitle">대화 속 결정부터 오래 쓸 지식까지.<br>나와 팀, 에이전트가 같은 맥락에서 이어갑니다.</p><a id="sign-in" class="button primary sign-in" href="/auth/login">계속하려면 로그인 <span aria-hidden="true">↗</span></a><p class="fine-print">기존 계정으로 안전하게 연결됩니다.</p><p id="welcome-error" class="error" role="alert" hidden></p></div>
    <div class="welcome-preview" aria-label="메모리 작업 공간 소개"><div class="preview-top"><span class="small-dot"></span><span>생각이 쌓이는 공간</span><span class="preview-corner" aria-hidden="true">↗</span></div><div class="preview-note"><span class="eyebrow">01 / CAPTURE</span><h2>다음 대화에 필요한 맥락</h2><p>무엇을 결정했는지, 왜 그랬는지.<br>흩어진 기록을 하나의 기억으로.</p><span class="tag">나의 공간</span><span class="tag">팀의 지식</span></div><div class="preview-bottom"><span class="preview-symbol" aria-hidden="true">↳</span><div><strong>저장하고, 찾고, 이어가세요.</strong><p>필요할 때 바로 꺼내 쓸 수 있도록.</p></div></div></div>
  </div><div class="trust-note"><span class="small-dot"></span><p><strong>Standard · 서버 관리형 저장</strong><br>서비스가 메모리를 저장하고 처리합니다. Zero-Access 암호화 서비스가 아닙니다.</p></div>
  <footer class="welcome-footer"><span>${name}</span><a href="${supportHref}">${support}</a></footer>
</section>
<div id="workspace" class="workspace" hidden>
  <aside class="sidebar" aria-label="작업 공간 탐색"><a class="brand" href="/" aria-label="${name} 홈"><span class="brand-mark" aria-hidden="true">${mark}</span><span>${shortName}</span></a><div class="sidebar-intro">기억이 이어지는 곳</div>
    <div class="sidebar-heading"><h2>공간</h2><button id="new-space" class="icon-button" type="button" aria-label="새 공간 만들기">+</button></div><nav id="space-list" class="space-list" aria-label="메모리 공간"></nav>
    <div class="sidebar-tools"><span class="sidebar-label">함께 쓰기</span><button id="new-organization" class="nav-action" type="button"><span aria-hidden="true">⊞</span> 조직 만들기</button><button id="manage-members" class="nav-action" type="button" hidden><span aria-hidden="true">◫</span> 조직 멤버 관리</button><button id="accept-invite" class="nav-action" type="button"><span aria-hidden="true">↳</span> 초대 코드로 참여</button><button id="manage-keys" class="nav-action" type="button"><span aria-hidden="true">⌘</span> 에이전트 연결 · API 키</button></div>
    <div class="sidebar-bottom"><div class="storage-note"><span class="small-dot"></span><div><strong>Standard</strong><span>서버 관리형 메모리</span></div></div><div class="account-line"><div class="account-avatar" aria-hidden="true">나</div><div><strong id="account-name">내 계정</strong><span id="account-email"></span></div><button id="logout" class="icon-button" type="button" aria-label="로그아웃">↗</button></div><a class="support-link" href="${supportHref}">${name} · 도움말</a></div>
  </aside>
  <main id="main-content" class="main-content" tabindex="-1"><div class="topbar"><span>${shortName} <span aria-hidden="true">/</span> <span id="breadcrumb">내 메모리</span></span><span class="topbar-note"><span class="small-dot"></span> 나의 맥락, 한곳에</span></div>
    <header class="page-heading"><div><p id="space-kind" class="eyebrow">PERSONAL SPACE</p><h1 id="space-title">내 메모리</h1><p id="space-description">남겨둔 생각을 다음 작업으로 이어가세요.</p></div><div class="heading-actions"><button id="invite-members" class="button secondary" type="button" hidden>멤버 초대</button><button id="new-memory" class="button primary" type="button"><span aria-hidden="true">+</span> 새 메모리</button></div></header>
    <div class="feedback"><p id="app-status" role="status" aria-live="polite"></p><p id="app-error" class="error" role="alert" hidden></p><button id="reload-memory" class="text-button" type="button" hidden>최신 내용 다시 불러오기</button><div id="reauth-actions" hidden><a id="reauthenticate" class="button secondary" href="/auth/login" target="_blank" rel="noopener noreferrer">새 탭에서 다시 로그인</a> <button id="resume-session" class="button primary" type="button">로그인 후 다시 연결</button><p class="field-help">초안은 이 창에만 남아 있어요. 이 창을 닫거나 새로고침하지 마세요. 필요하면 내용을 직접 복사해 두세요.</p></div></div>
    <section class="memory-console" aria-label="메모리 탐색 및 편집"><div class="memory-index"><form id="search-form" class="search-form" role="search"><label class="sr-only" for="search-query">메모리 검색</label><span class="search-symbol" aria-hidden="true">⌕</span><input id="search-query" name="query" type="search" maxlength="256" placeholder="기억 속에서 찾아보세요" autocomplete="off"><button class="sr-only" type="submit">검색</button></form><div class="list-caption"><span id="list-count">모든 메모리</span><span>최근 수정순</span></div><div id="memory-list" class="memory-list" aria-label="메모리 목록"></div><div id="list-empty" class="list-empty" hidden><span class="empty-mark" aria-hidden="true">↳</span><strong id="empty-title">아직 비어 있는 공간이에요.</strong><p id="empty-description">첫 번째 메모리로 시작해 보세요.</p></div><button id="load-more" class="load-more" type="button" hidden>더 불러오기</button></div>
    <div class="memory-detail"><div id="editor-empty" class="editor-empty"><span class="empty-mark" aria-hidden="true">✳</span><h2>다음에 다시 찾을 기억</h2><p>목록에서 메모리를 선택하거나<br>새 메모리를 작성해 보세요.</p></div><form id="editor-form" class="editor-form" hidden><div class="editor-top"><div><span id="editor-kind" class="eyebrow">MEMORY</span><p id="memory-meta" class="memory-meta"></p></div><span id="permission-badge" class="badge">편집 가능</span></div><label class="field-label" for="memory-body">내용</label><textarea id="memory-body" class="memory-body" name="body" required placeholder="기억해 둘 내용을 자유롭게 적어 보세요. 첫 줄은 목록의 제목으로 표시됩니다."></textarea><div class="source-field"><label class="field-label" for="memory-source">출처 <span>선택</span></label><input id="memory-source" name="source" type="text" placeholder="문서 이름, 회의, 대화 또는 링크" autocomplete="off"></div><div class="editor-footer"><span id="editor-hint">변경한 내용은 저장을 눌러 반영하세요.</span><div><button id="delete-memory" class="button danger" type="button">삭제</button><button id="save-memory" class="button primary" type="submit">변경사항 저장</button></div></div></form></div></section>
    <footer class="workspace-footer"><span>Standard · 서버에서 저장하고 처리합니다.</span><span>${name}</span></footer>
  </main>
</div>
<dialog id="memory-dialog" class="memory-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description"><div class="dialog-header"><span class="eyebrow">YOUR WORKSPACE</span><button id="dialog-close" class="icon-button" type="button" aria-label="창 닫기">×</button></div><h2 id="dialog-title"></h2><p id="dialog-description" class="dialog-description"></p><p id="dialog-error" class="error" role="alert" hidden></p><form id="dialog-form" class="dialog-form"></form><div class="dialog-footer"><button id="dialog-cancel" class="button secondary" type="button">닫기</button><button id="dialog-submit" class="button primary" type="submit" form="dialog-form">만들기</button></div></dialog>
<noscript><p class="noscript">이 작업 공간을 사용하려면 JavaScript를 활성화해 주세요. <a href="${supportHref}">도움 요청</a></p></noscript>
</body></html>`;
}

/** No user data is interpolated into this script or passed to HTML sinks. */
export const appScript = String.raw`(() => {
'use strict';
const $ = id => document.getElementById(id);
const state = { workspace: null, space: null, items: [], selected: null, draft: false, dirty: false, saving: false, nextCursor: null, query: '', authExpired: false, reconnecting: false, recovery: null };
let listEpoch = 0, detailEpoch = 0, workspaceEpoch = 0, dialogEpoch = 0, searchTimer;
let dialogAction = null;
const date = value => { const at = new Date(value); return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(at) : '기한 없음'; };
const node = (tag, className, content) => { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = String(content); return el; };
function status(message = '') { $('app-status').textContent = message; }
function clearError() { $('app-error').hidden = true; $('app-error').textContent = ''; $('reload-memory').hidden = true; }
function errorText(error) {
  if (error.status === 401) return '로그인이 만료되었어요. 다시 로그인해 주세요.';
  if (error.status === 403) return '이 작업에 필요한 권한이 없거나 변경되었어요. 공간을 다시 확인해 주세요.';
  if (error.status === 409) return '다른 곳에서 내용이 변경되었어요. 작성 중인 내용을 복사한 뒤 최신 내용을 불러와 주세요.';
  if (error.status === 429) return '요청이 많아 잠시 쉬고 있어요. 잠시 후 다시 시도해 주세요.';
  if (error.status === 400 || error.status === 413 || error.status === 422) return '입력 내용을 확인해 주세요. 이름은 100자, 본문은 16KB, 출처는 2KB까지 입력할 수 있어요.';
  return '요청을 완료하지 못했어요. 연결을 확인하고 다시 시도해 주세요.';
}
function showError(error, target = 'app-error') {
  if (error.handled) return;
  if (error.status === 401) {
    if (state.dirty && state.workspace && state.space) suspendAuthentication();
    else signedOut(errorText(error));
    return;
  }
  const el = $(target); el.textContent = errorText(error); el.hidden = false;
  if (error.status === 409 && target === 'app-error') $('reload-memory').hidden = false;
}
async function requestJson(path, method = 'GET', body) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(path, options);
  if (!response.ok) { const error = new Error('Request failed'); error.status = response.status; throw error; }
  return response.status === 204 ? null : response.json();
}
async function api(path, method = 'GET', body) {
  if (state.authExpired) { const error = new Error('Session requires reconnection'); error.status = 401; throw error; }
  // A recovered draft stays bound to its original account and Space until it
  // is saved or deliberately replaced. Recheck again immediately before retry.
  if (state.recovery && method !== 'GET' && !await resumeSession(false)) {
    const error = new Error('Recovery verification failed'); error.handled = true; throw error;
  }
  return requestJson(path, method, body);
}
function suspendAuthentication() {
  ++workspaceEpoch; ++listEpoch; ++detailEpoch; clearTimeout(searchTimer);
  if (!state.recovery) state.recovery = { accountId: state.workspace.account.id, spaceId: state.space.id };
  state.authExpired = true;
  if ($('memory-dialog').open) $('memory-dialog').close();
  $('reauth-actions').hidden = false; $('reload-memory').hidden = true;
  $('app-error').textContent = '로그인이 만료되었어요. 작성 중인 내용은 이 창에 남겨 두었어요. 새 탭에서 같은 계정으로 로그인한 뒤 다시 연결해 주세요.';
  $('app-error').hidden = false; status(''); updateActions();
}
async function resumeSession(notify = true) {
  if (!state.recovery || state.reconnecting) return false;
  const context = state.recovery, epoch = ++workspaceEpoch;
  state.reconnecting = true; updateActions();
  try {
    const fresh = await requestJson('/v1/workspace');
    if (epoch !== workspaceEpoch || state.recovery !== context) return false;
    if (fresh.account.id !== context.accountId) {
      signedOut('다른 계정으로 로그인되어 초안을 지웠어요. 원래 계정으로 다시 로그인해 주세요.'); return false;
    }
    const space = fresh.spaces.find(item => item.id === context.spaceId);
    if (!space || !space.canWrite) {
      state.authExpired = true; $('reauth-actions').hidden = false;
      $('app-error').textContent = '원래 공간의 쓰기 권한을 확인할 수 없어요. 초안은 이 창에 남아 있으니 필요한 내용을 복사해 두세요.';
      $('app-error').hidden = false; return false;
    }
    state.workspace = fresh; state.space = space; state.authExpired = false;
    $('account-email').textContent = fresh.account.emails[0] ? fresh.account.emails[0].address : '연결된 이메일 없음';
    $('reauth-actions').hidden = true; clearError(); renderSpaces();
    if (notify) status('같은 계정과 공간의 권한을 확인했어요. 초안을 다시 저장해 주세요.');
    return true;
  } catch (error) {
    if (epoch === workspaceEpoch && state.recovery === context) {
      state.authExpired = true; $('reauth-actions').hidden = false;
      $('app-error').textContent = errorText(error); $('app-error').hidden = false;
    }
    return false;
  } finally {
    if (state.recovery === context) { state.reconnecting = false; updateActions(); }
  }
}
function signedOut(message = '') {
  ++workspaceEpoch; ++listEpoch; ++detailEpoch;
  state.workspace = null; state.space = null; state.selected = null; state.items = []; state.dirty = false;
  state.authExpired = false; state.reconnecting = false; state.recovery = null; $('reauth-actions').hidden = true;
  $('memory-body').value = ''; $('memory-source').value = ''; $('memory-list').replaceChildren(); $('space-list').replaceChildren();
  if ($('memory-dialog').open) $('memory-dialog').close();
  $('boot').hidden = true; $('workspace').hidden = true; $('welcome').hidden = false;
  $('welcome-error').textContent = message; $('welcome-error').hidden = !message;
}
function mayLeave() { return !state.dirty || window.confirm('저장하지 않은 내용이 있어요. 이 내용을 닫을까요?'); }
function canWrite() { return Boolean(state.space && state.space.canWrite && !state.authExpired && !state.reconnecting); }
function setSaving(value) { state.saving = value; $('memory-body').disabled = value; $('memory-source').disabled = value; updateActions(); }
function updateActions() {
  const paused = state.authExpired || state.reconnecting;
  for (const id of ['new-space', 'manage-members', 'accept-invite', 'manage-keys', 'invite-members']) $(id).disabled = paused || !state.workspace;
  $('new-organization').disabled = paused || !state.workspace || !state.workspace.account.emails.length;
  $('search-query').disabled = paused || !state.space; $('load-more').disabled = paused;
  $('resume-session').disabled = state.reconnecting;
  for (const button of document.querySelectorAll('#space-list button, #memory-list button')) button.disabled = paused || state.saving;
  $('new-memory').disabled = !canWrite() || state.saving;
  $('save-memory').disabled = !canWrite() || state.saving || (!state.selected && !state.draft);
  $('delete-memory').disabled = !canWrite() || state.saving || !state.selected;
  $('memory-body').readOnly = !canWrite(); $('memory-source').readOnly = !canWrite();
  $('permission-badge').textContent = canWrite() ? '편집 가능' : '읽기 전용';
  $('editor-hint').textContent = canWrite() ? '변경한 내용은 저장을 눌러 반영하세요.' : '이 공간에서는 메모리를 읽을 수 있어요.';
}
function renderEditor(memory, draft = false) {
  if (!state.authExpired) state.recovery = null;
  state.selected = memory; state.draft = draft; state.dirty = false;
  $('editor-empty').hidden = Boolean(memory || draft); $('editor-form').hidden = !memory && !draft;
  $('memory-body').value = memory ? memory.body : ''; $('memory-source').value = memory && memory.source ? memory.source : '';
  $('editor-kind').textContent = draft ? 'NEW MEMORY' : 'MEMORY';
  $('memory-meta').textContent = memory ? date(memory.updatedAt) + ' 수정 · 버전 ' + memory.revision : '아직 저장하지 않은 새 메모리';
  $('save-memory').textContent = draft ? '메모리 저장' : '변경사항 저장';
  updateActions(); renderList();
}
function renderList() {
  const list = $('memory-list'); list.replaceChildren();
  for (const item of state.items) {
    const button = node('button', 'memory-row'); button.type = 'button';
    button.disabled = state.authExpired || state.reconnecting || state.saving;
    const excerpt = String(item.body ?? item.snippet ?? '');
    const title = excerpt.trim().split('\n')[0].slice(0, 90) || '메모리';
    button.append(node('strong', 'memory-row-title', title), node('span', 'memory-row-preview', excerpt.slice(0, 170)));
    const meta = node('span', 'memory-row-meta'); meta.append(node('span', '', item.source || '메모리'), node('span', '', item.updatedAt ? date(item.updatedAt) : '버전 ' + item.revision)); button.append(meta);
    if (state.selected && state.selected.id === item.id) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => { if (mayLeave()) selectMemory(item.id); }); list.append(button);
  }
  $('list-count').textContent = state.items.length + '개 표시' + (state.query ? ' · 검색 결과' : '');
  $('list-empty').hidden = state.items.length > 0;
  $('empty-title').textContent = state.query ? '일치하는 메모리가 없어요.' : '아직 비어 있는 공간이에요.';
  $('empty-description').textContent = state.query ? '다른 단어로 다시 찾아보세요.' : canWrite() ? '첫 번째 메모리로 시작해 보세요.' : '팀이 공유한 메모리가 여기에 표시됩니다.';
  $('load-more').hidden = !state.nextCursor || Boolean(state.query);
}
async function selectMemory(id) {
  if (!state.space || state.saving || state.authExpired || state.reconnecting) return;
  const epoch = ++detailEpoch, spaceId = state.space.id; status('메모리를 불러오는 중…'); clearError();
  try { const memory = await api('/v1/spaces/' + encodeURIComponent(spaceId) + '/memories/' + encodeURIComponent(id)); if (epoch !== detailEpoch || !state.space || state.space.id !== spaceId) return; renderEditor(memory); status(''); }
  catch (error) { if (epoch === detailEpoch) { status(''); showError(error); } }
}
async function loadItems(append = false) {
  if (!state.space || state.authExpired || state.reconnecting) return;
  const epoch = ++listEpoch, spaceId = state.space.id;
  let path = '/v1/spaces/' + encodeURIComponent(spaceId) + '/memories';
  if (state.query) path += '?query=' + encodeURIComponent(state.query);
  else if (append && state.nextCursor) path += '?cursor=' + encodeURIComponent(state.nextCursor);
  status(state.query ? '기억을 찾고 있어요…' : '메모리를 불러오는 중…'); $('load-more').disabled = true;
  try {
    const result = await api(path); if (epoch !== listEpoch || !state.space || state.space.id !== spaceId) return;
    state.items = append ? state.items.concat(result.results.filter(item => !state.items.some(old => old.id === item.id))) : result.results;
    state.nextCursor = result.nextCursor || null; renderList(); status('');
    if (!state.selected && !state.draft && state.items.length) await selectMemory(state.items[0].id);
  } catch (error) { if (epoch === listEpoch) { status(''); showError(error); } }
  finally { if (epoch === listEpoch) $('load-more').disabled = false; }
}
function renderSpaces() {
  $('space-list').replaceChildren();
  for (const space of state.workspace.spaces) {
    const button = node('button', 'space-button'); button.type = 'button';
    button.disabled = state.authExpired || state.reconnecting || state.saving;
    button.append(node('span', 'space-symbol', space.organizationId ? '◫' : '◈'), node('span', 'space-name', space.name));
    if (!space.canWrite) button.append(node('span', 'space-readonly', '읽기'));
    if (state.space && space.id === state.space.id) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => { if (!state.saving && mayLeave()) selectSpace(space.id); }); $('space-list').append(button);
  }
}
async function selectSpace(id) {
  if (state.authExpired || state.reconnecting) return;
  ++detailEpoch; state.space = state.workspace.spaces.find(space => space.id === id) || null;
  state.items = []; state.nextCursor = null; state.query = ''; $('search-query').value = ''; clearError(); renderEditor(null); renderSpaces();
  $('space-title').textContent = state.space ? state.space.name : '첫 공간을 만들어 보세요'; $('breadcrumb').textContent = state.space ? state.space.name : '작업 공간';
  $('space-kind').textContent = state.space && state.space.organizationId ? 'TEAM SPACE' : 'PERSONAL SPACE';
  $('space-description').textContent = state.space && state.space.organizationId ? '팀의 결정과 지식을 같은 맥락에서 이어가세요.' : '남겨둔 생각을 다음 작업으로 이어가세요.';
  const organization = state.space && state.workspace.organizations.find(org => org.id === state.space.organizationId);
  const parent = organization && organization.parentId && state.workspace.organizations.find(org => org.id === organization.parentId);
  if (parent) $('space-description').textContent = '상위 조직: ' + parent.name + ' · 멤버십과 메모리 접근 권한은 각각 관리됩니다.';
  $('invite-members').hidden = !organization || !['owner', 'admin'].includes(organization.role);
  if (state.space) await loadItems();
}
async function loadWorkspace(preferredSpace) {
  const epoch = ++workspaceEpoch;
  try {
    const result = await api('/v1/workspace'); if (epoch !== workspaceEpoch) return;
    state.workspace = result; $('boot').hidden = true; $('welcome').hidden = true; $('workspace').hidden = false;
    $('account-email').textContent = result.account.emails[0] ? result.account.emails[0].address : '연결된 이메일 없음';
    $('new-organization').disabled = !result.account.emails.length;
    $('manage-members').hidden = !result.organizations.some(org => ['owner', 'admin'].includes(org.role));
    const chosen = result.spaces.find(space => space.id === preferredSpace) || result.spaces.find(space => state.space && space.id === state.space.id) || result.spaces[0];
    await selectSpace(chosen ? chosen.id : null);
  } catch (error) { if (epoch === workspaceEpoch) { if (error.status === 401 && state.dirty && state.space) suspendAuthentication(); else signedOut(error.status === 401 ? '' : errorText(error)); } }
}
async function saveMemory(event) {
  event.preventDefault(); if (!canWrite() || state.saving || (!state.selected && !state.draft)) return;
  const body = $('memory-body').value, source = $('memory-source').value || null;
  if (!body.trim() || body.includes('\0') || (source && source.includes('\0')) || new TextEncoder().encode(body).length > 16384 || (source && new TextEncoder().encode(source).length > 2048)) { showError({ status: 400 }); return; }
  const spaceId = state.space.id; let path = '/v1/spaces/' + encodeURIComponent(spaceId) + '/memories';
  const updating = state.selected; if (updating) path += '/' + encodeURIComponent(updating.id);
  clearError(); setSaving(true); status('저장하고 있어요…');
  try {
    const saved = await api(path, updating ? 'PATCH' : 'POST', updating ? { body, source, expectedRevision: updating.revision } : { body, source });
    if (!state.space || state.space.id !== spaceId) return;
    renderEditor(saved); await loadItems(); status('저장했어요. 다음 작업에서 이어가세요.');
  } catch (error) { showError(error); status(''); }
  finally { setSaving(false); }
}
async function deleteMemory() {
  if (!canWrite() || !state.selected || state.saving || !window.confirm('이 메모리를 삭제할까요? 목록과 검색에서 사라지며, 기존 버전과 삭제 이력은 서버에 보존됩니다.')) return;
  clearError(); setSaving(true); const selected = state.selected;
  try { await api('/v1/spaces/' + encodeURIComponent(state.space.id) + '/memories/' + encodeURIComponent(selected.id), 'DELETE', { expectedRevision: selected.revision }); renderEditor(null); await loadItems(); status('메모리를 삭제했어요.'); }
  catch (error) { showError(error); } finally { setSaving(false); }
}
function field(name, label, options = {}) {
  const wrap = node('div', 'form-field'); const caption = node('label', 'field-label', label); caption.htmlFor = 'field-' + name;
  const input = node(options.options ? 'select' : options.multiline ? 'textarea' : 'input'); input.id = 'field-' + name; input.name = name;
  if (options.options) for (const choice of options.options) { const option = node('option', '', choice.label); option.value = choice.value; input.append(option); }
  else { if (!options.multiline) input.type = options.type || 'text'; input.autocomplete = 'off'; }
  input.required = options.required !== false;
  if (options.maxLength) input.maxLength = options.maxLength;
  if (options.value !== undefined) input.value = options.value;
  if (options.placeholder) input.placeholder = options.placeholder;
  wrap.append(caption, input); if (options.help) wrap.append(node('p', 'field-help', options.help)); $('dialog-form').append(wrap); return input;
}
function openDialog(title, description, button = '만들기') {
  ++dialogEpoch; dialogAction = null; $('dialog-form').replaceChildren(); $('dialog-error').hidden = true; $('dialog-error').textContent = '';
  $('dialog-title').textContent = title; $('dialog-description').textContent = description; $('dialog-submit').textContent = button; $('dialog-submit').hidden = false; $('dialog-submit').disabled = false;
  if (!$('memory-dialog').open) $('memory-dialog').showModal();
}
function closeDialog() { $('memory-dialog').close(); }
function organizationChoices(writersOnly = false) { return state.workspace.organizations.filter(org => !writersOnly || ['owner', 'admin'].includes(org.role)).map(org => ({ value: org.id, label: org.name })); }
function focusFirst() { const input = $('dialog-form').querySelector('input,select,textarea'); if (input) input.focus(); }
function showSecret(result, invite) {
  $('dialog-form').replaceChildren(); $('dialog-submit').hidden = true; dialogAction = null;
  $('dialog-title').textContent = invite ? '초대 코드가 준비됐어요' : 'API 키가 준비됐어요';
  $('dialog-description').textContent = invite ? '초대할 분에게 코드를 직접 전달해 주세요. 이메일은 자동으로 발송되지 않습니다.' : '이 창을 닫으면 키를 다시 볼 수 없어요. 신뢰하는 에이전트 설정에만 저장해 주세요.';
  const label = node('label', 'field-label', invite ? '한 번만 표시되는 초대 코드' : '한 번만 표시되는 API 키'); label.htmlFor = 'issued-secret';
  const secret = node('textarea', 'secret-value'); secret.id = 'issued-secret'; secret.readOnly = true; secret.value = result.token; secret.setAttribute('spellcheck', 'false');
  const copy = node('button', 'button secondary', '복사하기'); copy.type = 'button';
  copy.addEventListener('click', async () => { try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(secret.value); copy.textContent = '복사했어요'; } catch { secret.focus(); secret.select(); copy.textContent = '선택된 코드를 직접 복사해 주세요'; } });
  $('dialog-form').append(label, secret, copy, node('p', 'field-help', '만료: ' + date(result.expiresAt)));
  if (!invite) appendConnection(); secret.focus();
}
function appendConnection() {
  const note = node('div', 'connection-note'); note.append(node('strong', '', '에이전트 연결'), node('p', '', 'MCP 엔드포인트'), node('code', '', 'https://memory.allenlabs.org/mcp'), node('p', '', '인증 헤더'), node('code', '', 'Authorization: Bearer <API_KEY>')); $('dialog-form').append(note);
}
function openSpace() {
  if (!state.workspace || state.authExpired || state.reconnecting || !mayLeave()) return;
  openDialog('새 공간 만들기', '작업이나 팀에 따라 기억을 나누어 보세요. 모든 공간은 Standard 서버 관리형입니다.');
  field('name', '공간 이름', { maxLength: 100, placeholder: '예: 프로젝트 노트' }); field('organizationId', '소유 공간', { options: [{ value: '', label: '개인 공간' }, ...organizationChoices(true)], required: false });
  dialogAction = async epoch => { const input = { name: $('field-name').value, securityMode: 'managed' }; if ($('field-organizationId').value) input.organizationId = $('field-organizationId').value; const space = await api('/v1/spaces', 'POST', input); if (epoch !== dialogEpoch) return; closeDialog(); await loadWorkspace(space.id); }; focusFirst();
}
function openOrganization() {
  if (!state.workspace || state.authExpired || state.reconnecting || !state.workspace.account.emails.length || !mayLeave()) return;
  openDialog('함께 쓰는 조직 만들기', '조직 멤버십은 선택한 인증 이메일에 연결됩니다. 해당 이메일의 권한이 해제되면 조직 접근도 해제됩니다.');
  field('name', '조직 이름', { maxLength: 100, placeholder: '예: 디자인 팀' }); field('emailId', '조직에 연결할 이메일', { options: state.workspace.account.emails.map(email => ({ value: email.id, label: email.address })) });
  field('parentOrganizationId', '상위 조직', { options: [{ value: '', label: '없음 · 독립된 조직' }, ...organizationChoices(true)], required: false, help: '상위 조직을 선택해도 멤버십과 메모리 접근 권한은 자동으로 상속되지 않습니다.' });
  dialogAction = async epoch => { const input = { name: $('field-name').value, emailId: $('field-emailId').value }; if ($('field-parentOrganizationId').value) input.parentOrganizationId = $('field-parentOrganizationId').value; const result = await api('/v1/organizations', 'POST', input); if (epoch !== dialogEpoch) return; closeDialog(); await loadWorkspace(result.spaceId); }; focusFirst();
}
function openInvitation() {
  if (!state.space || state.authExpired || state.reconnecting || !state.space.organizationId) return;
  const organizationId = state.space.organizationId;
  const organization = state.workspace.organizations.find(org => org.id === organizationId);
  if (!organization || !['owner', 'admin'].includes(organization.role)) return;
  openDialog('멤버 초대하기', '지정한 이메일을 인증한 계정만 참여할 수 있어요. 생성한 코드는 직접 전달해 주세요.', '초대 코드 만들기');
  field('email', '초대할 이메일', { type: 'email', maxLength: 254, placeholder: 'name@company.com' }); field('role', '역할', { options: [{ value: 'member', label: '멤버 · 메모리 읽기' }, { value: 'admin', label: '관리자 · 메모리 편집 및 멤버 초대' }] });
  dialogAction = async epoch => { const result = await api('/v1/organizations/' + encodeURIComponent(organizationId) + '/invites', 'POST', { email: $('field-email').value, role: $('field-role').value }); if (epoch !== dialogEpoch) return; showSecret(result, true); }; focusFirst();
}
function openAccept() {
  if (!state.workspace || state.authExpired || state.reconnecting || !mayLeave()) return;
  openDialog('초대 코드로 참여하기', '초대받은 이메일이 현재 계정에 연결되어 있어야 해요.', '참여하기');
  field('token', '초대 코드', { multiline: true, placeholder: '전달받은 초대 코드를 붙여 넣으세요' });
  dialogAction = async epoch => { await api('/v1/invitations/accept', 'POST', { token: $('field-token').value.trim() }); if (epoch !== dialogEpoch) return; closeDialog(); await loadWorkspace(); status('조직에 참여했어요. 새 공간을 확인해 보세요.'); }; focusFirst();
}
function openMembers() {
  if (!state.workspace || state.authExpired || state.reconnecting) return;
  const choices = organizationChoices(true); if (!choices.length) return;
  openDialog('조직 멤버 관리', '멤버십을 해제하면 해당 조직의 접근 권한과 파생 API 키가 해제됩니다. 개인 계정과 개인 메모리는 유지됩니다.');
  $('dialog-submit').hidden = true;
  const select = field('organizationId', '관리할 조직', { options: choices });
  if (state.space && choices.some(choice => choice.value === state.space.organizationId)) select.value = state.space.organizationId;
  const list = node('div', 'key-list'); list.id = 'members-list'; list.setAttribute('aria-live', 'polite'); $('dialog-form').append(list);
  const epoch = dialogEpoch; let generation = 0;
  async function loadMembers() {
    const current = ++generation, organizationId = select.value; list.replaceChildren(node('p', 'field-help', '멤버를 불러오는 중…'));
    try {
      const result = await api('/v1/organizations/' + encodeURIComponent(organizationId) + '/members');
      if (epoch !== dialogEpoch || current !== generation) return;
      list.replaceChildren();
      for (const member of result.results) {
        const row = node('div', 'key-row'); const details = node('div');
        details.append(node('strong', '', member.email || member.accountId), node('span', '', ({ owner: '소유자', admin: '관리자', member: '멤버' })[member.role] + ' · ' + date(member.expiresAt)));
        const remove = node('button', 'text-button danger', '멤버십 해제'); remove.type = 'button'; remove.setAttribute('aria-label', (member.email || member.accountId) + ' 멤버십 해제');
        remove.addEventListener('click', async () => {
          if (!window.confirm('이 멤버의 조직 접근과 조직 API 키를 해제할까요? 개인 계정과 개인 메모리는 유지됩니다.')) return;
          remove.disabled = true;
          try {
            await api('/v1/organizations/' + encodeURIComponent(organizationId) + '/memberships/' + encodeURIComponent(member.id), 'DELETE');
            if (epoch !== dialogEpoch || current !== generation) return;
            if (member.accountId === state.workspace.account.id) { closeDialog(); await loadWorkspace(); }
            else { row.remove(); if (!list.children.length) list.append(node('p', 'field-help', '표시할 멤버가 없어요.')); }
          } catch (error) { if (epoch === dialogEpoch && current === generation) { showError(error, 'dialog-error'); remove.disabled = false; } }
        });
        row.append(details, remove); list.append(row);
      }
      if (!result.results.length) list.append(node('p', 'field-help', '표시할 멤버가 없어요.'));
    } catch (error) { if (epoch === dialogEpoch && current === generation) { list.replaceChildren(); showError(error, 'dialog-error'); } }
  }
  select.addEventListener('change', loadMembers); loadMembers(); focusFirst();
}
function openKeys() {
  if (!state.workspace || state.authExpired || state.reconnecting) return;
  openDialog('에이전트 연결 · API 키', '필요한 공간과 권한만 연결하세요. 키는 발급 즉시 한 번만 표시됩니다.', 'API 키 발급');
  const keys = state.workspace.keys.filter(key => key.revokedAt == null);
  if (keys.length) {
    const list = node('div', 'key-list'); list.append(node('h3', '', '발급한 키'));
    for (const key of keys) {
      const row = node('div', 'key-row'); const details = node('div'); details.append(node('strong', '', key.label), node('span', '', (key.permission === 'write' ? '읽기 · 쓰기' : '읽기') + ' · ' + date(key.expiresAt) + ' 만료'));
      const revoke = node('button', 'text-button danger', '해제'); revoke.type = 'button'; revoke.setAttribute('aria-label', key.label + ' 키 해제');
      revoke.addEventListener('click', async () => { if (!window.confirm('이 키의 에이전트 접근을 해제할까요?')) return; revoke.disabled = true; try { await api('/v1/keys/' + encodeURIComponent(key.id), 'DELETE'); state.workspace.keys = state.workspace.keys.filter(item => item.id !== key.id); row.remove(); } catch (error) { showError(error, 'dialog-error'); revoke.disabled = false; } });
      row.append(details, revoke); list.append(row);
    } $('dialog-form').append(list);
  }
  field('label', '새 키 이름', { maxLength: 100, placeholder: '예: 개인 개발 에이전트' });
  field('organizationId', '접근 범위', { options: [{ value: '', label: '나의 개인 공간' }, ...organizationChoices()], required: false });
  field('permission', '권한', { options: [{ value: 'read', label: '읽기 전용' }, { value: 'write', label: '읽기 · 쓰기' }] });
  field('expiresInDays', '유효 기간', { options: [{ value: '7', label: '7일' }, { value: '30', label: '30일' }, { value: '90', label: '90일' }], value: '30' }); appendConnection();
  dialogAction = async epoch => { const input = { label: $('field-label').value, permission: $('field-permission').value, expiresInDays: Number($('field-expiresInDays').value) }; if ($('field-organizationId').value) input.organizationId = $('field-organizationId').value; const result = await api('/v1/keys', 'POST', input); if (epoch !== dialogEpoch || !state.workspace) return; state.workspace.keys.push({ id: result.id, label: input.label, permission: input.permission, organizationId: input.organizationId || null, expiresAt: result.expiresAt, revokedAt: null }); showSecret(result, false); }; focusFirst();
}
$('editor-form').addEventListener('submit', saveMemory);
$('resume-session').addEventListener('click', () => resumeSession());
$('memory-body').addEventListener('input', () => { state.dirty = true; }); $('memory-source').addEventListener('input', () => { state.dirty = true; });
$('new-memory').addEventListener('click', () => { if (canWrite() && !state.saving && mayLeave()) { ++detailEpoch; clearError(); renderEditor(null, true); $('memory-body').focus(); } });
$('delete-memory').addEventListener('click', deleteMemory);
$('reload-memory').addEventListener('click', () => { if (state.selected && mayLeave()) selectMemory(state.selected.id); });
function search() { clearTimeout(searchTimer); state.query = $('search-query').value.trim(); clearError(); loadItems(); }
$('search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
$('search-query').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 300); });
$('load-more').addEventListener('click', () => loadItems(true));
$('new-space').addEventListener('click', openSpace); $('new-organization').addEventListener('click', openOrganization);
$('manage-members').addEventListener('click', openMembers);
$('invite-members').addEventListener('click', openInvitation); $('accept-invite').addEventListener('click', openAccept); $('manage-keys').addEventListener('click', openKeys);
$('dialog-close').addEventListener('click', closeDialog); $('dialog-cancel').addEventListener('click', closeDialog);
$('memory-dialog').addEventListener('close', () => { ++dialogEpoch; dialogAction = null; for (const input of $('dialog-form').querySelectorAll('input,textarea')) input.value = ''; $('dialog-form').replaceChildren(); $('dialog-error').textContent = ''; });
$('dialog-form').addEventListener('submit', async event => { event.preventDefault(); if (!dialogAction || $('dialog-submit').disabled) return; const epoch = dialogEpoch; $('dialog-submit').disabled = true; $('dialog-error').hidden = true; try { await dialogAction(epoch); } catch (error) { if (epoch === dialogEpoch) showError(error, 'dialog-error'); } finally { if (epoch === dialogEpoch) $('dialog-submit').disabled = false; } });
$('logout').addEventListener('click', async () => { if (!mayLeave()) return; try { const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'follow' }); if (!response.ok) { const error = new Error('Logout failed'); error.status = response.status; throw error; } signedOut(); } catch (error) { showError(error); } });
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('memory-dialog').open && !$('editor-form').hidden) { event.preventDefault(); $('editor-form').requestSubmit(); } });
loadWorkspace();
})();`;

export function renderStyles(brand: Brand): string {
  const accent = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(brand.accentColor) ? brand.accentColor : '#356852';
  return `:root{--accent:${accent};--ink:#24342d;--muted:#778078;--paper:#f7f8f4;--surface:#fff;--line:#e6e9e1;--soft:#eff3ed;--danger:#a3483e;font-family:"Pretendard Variable","Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper);font-synthesis:none}*{box-sizing:border-box}body{margin:0;font-size:14px;line-height:1.65}button,input,textarea,select{font:inherit}button,a,input,textarea,select{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.44}a{color:inherit;text-decoration:none}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button{color:inherit}[hidden]{display:none!important}h1,h2,h3,p{margin:0}button{border:0}input,textarea,select{min-width:0;color:var(--ink)}input,select,textarea{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:11px 12px}input::placeholder,textarea::placeholder{color:#9aA299}textarea{resize:vertical}input:focus,textarea:focus,select:focus{border-color:var(--accent)}input:read-only,textarea:read-only{color:#626e64}.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.skip-link{position:fixed;top:-80px;left:16px;padding:10px 18px;background:var(--ink);color:white;z-index:20}.skip-link:focus{top:12px}.brand{display:flex;align-items:center;gap:11px;font-size:20px;line-height:1.3;font-weight:680;letter-spacing:-.7px}.brand-mark{display:inline-grid;place-items:center;background:var(--accent);color:white;width:34px;height:36px;border-radius:9px 9px 9px 2px;font-size:22px;font-family:Georgia,serif;font-weight:500}.badge{display:inline-flex;align-items:center;border:1px solid #dce5d9;padding:3px 9px;border-radius:5px;font-size:11px;line-height:1.6;color:#5e7560;background:#f5f8f2;white-space:nowrap}.small-dot{display:inline-block;background:var(--accent);height:6px;width:6px;border-radius:50%;flex:none}.eyebrow{font-size:10px;letter-spacing:1.8px;font-weight:700;color:#819180}.button{display:inline-flex;justify-content:center;align-items:center;gap:10px;border-radius:8px;padding:11px 16px;font-size:13px;font-weight:600;line-height:1.35;border:1px solid transparent;white-space:nowrap;transition:background .15s,transform .15s}.button:active:not(:disabled){transform:translateY(1px)}.primary{background:var(--accent);color:#fff}.primary:hover:not(:disabled){filter:brightness(.94)}.secondary{border-color:var(--line);background:white}.secondary:hover{background:#f7f9f4}.danger{color:var(--danger);background:transparent}.button.danger:hover{background:#fff1ed}.icon-button{display:grid;place-items:center;height:30px;width:30px;border-radius:6px;background:transparent;font-size:23px;line-height:1;color:#82907f}.icon-button:hover{background:#e8eee3;color:var(--ink)}.text-button{background:transparent;padding:4px 0;color:var(--accent);font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:3px}.error{font-size:13px;color:#914336;padding:12px 15px;background:#fff3ec;border:1px solid #f1dcd0;border-radius:8px}.boot{min-height:100vh;display:flex;align-items:center;justify-content:center;gap:17px;color:var(--muted)}.welcome{max-width:1200px;margin:auto;padding:35px 52px 22px}.welcome-header{display:flex;align-items:center;justify-content:space-between}.welcome-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:72px;align-items:center;min-height:640px;padding:52px 0}.welcome-copy h1{font-size:clamp(34px,3.4vw,48px);line-height:1.4;letter-spacing:-2.3px;font-weight:640;margin:24px 0}.welcome-description{font-size:16px;color:#506052;max-width:390px;line-height:1.8}.welcome-subtitle{font-size:14px;color:var(--muted);line-height:1.9;margin-top:14px}.sign-in{margin-top:30px;padding:14px 20px;gap:35px}.fine-print{font-size:11px;color:#92998e;margin-top:12px}.welcome-copy .error{margin-top:20px}.welcome-preview{border:1px solid #dde5d7;border-radius:14px;background:#f1f4eb;box-shadow:0 18px 50px #24342d08;transform:rotate(1.2deg);overflow:hidden}.preview-top{padding:22px 24px;display:flex;align-items:center;gap:9px;font-size:11px;color:#75836f;border-bottom:1px solid #e1e7d9}.preview-corner{margin-left:auto;font-size:20px}.preview-note{margin:22px;background:#fffefb;border:1px solid #e6e7db;border-radius:8px;padding:32px 26px;transform:rotate(-2deg);box-shadow:0 6px 14px #24342d05}.preview-note h2{font-size:21px;letter-spacing:-.8px;margin:17px 0 12px;font-weight:600}.preview-note p{font-size:13px;color:#87907f;line-height:1.9}.tag{display:inline-block;margin:25px 5px 0 0;background:#f3f5ef;border:1px solid #e6ebdf;border-radius:4px;padding:3px 8px;font-size:10px;color:#839276}.preview-bottom{padding:14px 27px 32px;display:flex;gap:20px;align-items:center}.preview-symbol{font-size:32px;color:#99ad8d}.preview-bottom strong{font-weight:550;font-size:12px}.preview-bottom p{font-size:11px;color:#8c9784;margin-top:2px}.trust-note{display:flex;align-items:flex-start;gap:11px;border-top:1px solid var(--line);padding:23px 0;font-size:11px;color:#8b9386}.trust-note .small-dot{margin-top:7px}.trust-note strong{font-weight:550;color:#64735e}.welcome-footer{display:flex;justify-content:space-between;font-size:10px;color:#92988f;padding:14px 0}.workspace{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}.sidebar{background:#f0f3eb;border-right:1px solid #e2e7dc;display:flex;flex-direction:column;padding:30px 20px 16px;min-height:100vh}.sidebar .brand{padding-left:7px}.sidebar-intro{font-size:10px;color:#97a08f;margin:11px 0 33px 53px;letter-spacing:.3px}.sidebar-heading{display:flex;align-items:center;justify-content:space-between;padding:0 7px 9px}.sidebar-heading h2,.sidebar-label{font-size:10px;font-weight:600;color:#96a08e;letter-spacing:.7px}.space-list{display:grid;gap:4px}.space-button{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;background:transparent;border-radius:7px;text-align:left;font-size:12px;color:#687961}.space-button:hover{background:#e9eee1}.space-button[aria-current]{background:#e1e9d8;color:#3e5c3f;font-weight:650}.space-symbol{font-size:18px;font-weight:400;color:#86997b}.space-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.space-readonly{font-size:9px;font-weight:400;margin-left:auto;white-space:nowrap}.sidebar-tools{margin-top:35px;padding-top:22px;border-top:1px solid #e1e7da}.sidebar-label{display:block;padding:0 8px 12px}.nav-action{display:flex;gap:11px;align-items:center;width:100%;padding:10px 9px;text-align:left;background:transparent;font-size:11px;color:#7c8872;border-radius:6px}.nav-action span{font-size:16px;color:#93a086;width:16px;text-align:center}.nav-action:hover{background:#e7eddf}.sidebar-bottom{margin-top:auto;padding-top:65px}.storage-note{display:flex;gap:9px;align-items:center;margin:0 8px 24px}.storage-note strong{display:block;color:#6e805f;font-size:10px;font-weight:600}.storage-note span:not(.small-dot){display:block;font-size:9px;color:#96a08e}.account-line{display:flex;align-items:center;gap:8px;padding:16px 0 13px;border-top:1px solid #e0e6d9}.account-avatar{display:grid;place-items:center;background:#e1e7d8;height:30px;width:30px;border-radius:50%;font-size:11px;color:#7b8b6d;flex:none}.account-line>div:nth-child(2){min-width:0;flex:1}.account-line strong{display:block;font-size:10px;font-weight:600}.account-line span{display:block;font-size:9px;color:#939c8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-line .icon-button{font-size:18px;width:20px}.support-link{font-size:9px;color:#9aa28f;display:block;padding-left:3px}.main-content{padding:0 42px;min-width:0;max-width:1600px;width:100%;margin:auto;align-self:start}.topbar{height:78px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;color:#9aa28f;font-size:10px}.topbar>span:first-child{display:flex;align-items:center;gap:14px}.topbar-note{display:flex;align-items:center;gap:8px}.topbar-note .small-dot{height:4px;width:4px;background:#9cac8d}.page-heading{display:flex;justify-content:space-between;align-items:center;padding:39px 0 22px;gap:20px}.page-heading h1{font-size:29px;font-weight:640;letter-spacing:-1.2px;line-height:1.5;margin:7px 0}.page-heading p:not(.eyebrow){font-size:12px;color:#8d9784}.heading-actions{display:flex;gap:8px}.feedback{min-height:30px;padding-bottom:12px}.feedback #app-status{font-size:11px;color:#7d8b72}.feedback .error{margin:3px 0 6px}.memory-console{display:grid;grid-template-columns:minmax(220px,34%) minmax(0,1fr);border:1px solid var(--line);border-radius:12px;background:white;overflow:hidden;min-height:570px;box-shadow:0 3px 15px #24342d02}.memory-index{border-right:1px solid var(--line);min-width:0}.search-form{margin:20px 17px 17px;position:relative}.search-form input{width:100%;background:#f8faf5;border-color:#ecf0e7;border-radius:7px;padding:10px 10px 10px 34px;font-size:11px}.search-symbol{position:absolute;left:12px;top:7px;font-size:20px;color:#9ca991}.list-caption{display:flex;justify-content:space-between;padding:0 19px 14px;color:#a0a998;font-size:9px}.memory-list{min-width:0;overflow:hidden;display:grid;align-content:start}.memory-row{min-width:0;overflow:hidden;display:block;width:100%;padding:18px 20px;border-top:1px solid #f0f2ec;background:white;text-align:left;border-left:2px solid transparent}.memory-row:hover{background:#fafcf7}.memory-row[aria-current]{background:#f1f5eb;border-left-color:var(--accent)}.memory-row-title{min-width:0;max-width:100%;display:block;font-size:12px;line-height:1.6;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#516148}.memory-row-preview{min-width:0;max-width:100%;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#99a18f;font-size:10px;line-height:1.8;margin-top:5px;white-space:pre-line;overflow-wrap:anywhere}.memory-row-meta{min-width:0;max-width:100%;overflow:hidden;display:flex;justify-content:space-between;gap:12px;font-size:8px;color:#9ba78e;margin-top:13px}.memory-row-meta span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}.load-more{width:calc(100% - 36px);margin:14px 18px;background:#f5f8ef;border:1px solid var(--line);border-radius:6px;padding:9px;font-size:11px;color:#819473}.list-empty{padding:45px 22px;text-align:center}.empty-mark{display:block;font-size:29px;color:#afbea3;font-weight:400;margin-bottom:14px}.list-empty strong{display:block;font-size:12px;font-weight:500;color:#7c8d70}.list-empty p{font-size:10px;color:#a3ad99;margin-top:6px}.memory-detail{min-width:0;display:flex;flex-direction:column}.editor-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:65px 20px;min-height:400px}.editor-empty .empty-mark{font-size:38px;margin-bottom:20px}.editor-empty h2{font-size:16px;font-weight:500;color:#748568;margin-bottom:10px}.editor-empty p{font-size:11px;color:#a0ac94;line-height:1.9}.editor-form{display:flex;flex-direction:column;min-height:570px;padding:27px 28px 0;flex:1}.editor-top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:25px}.editor-top .eyebrow{font-size:9px}.memory-meta{font-size:9px;color:#a2ab98;margin-top:6px}.field-label{display:block;font-size:11px;font-weight:600;color:#6c7d60;margin-bottom:7px}.field-label span{font-size:9px;color:#a3ac99;font-weight:400;margin-left:5px}.memory-body{display:block;flex:1;width:100%;min-height:260px;line-height:1.9;font-size:13px;padding:13px 14px;border-color:#edf0e8;background:#fff;resize:vertical;border-radius:7px;overflow-wrap:anywhere}.source-field{margin:20px 0}.source-field input{width:100%;font-size:11px;background:#fafbf8;border-color:#edf0e8;padding:9px 11px}.editor-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);margin:0 -28px;padding:17px 22px;background:#fdfefa}.editor-footer>span{font-size:9px;color:#a2ac97;max-width:45%}.editor-footer>div{display:flex;gap:6px}.editor-footer .button{font-size:11px;padding:10px 12px}.workspace-footer{display:flex;justify-content:space-between;font-size:9px;color:#a3ab98;padding:19px 0 25px}.memory-dialog{width:min(540px,calc(100% - 32px));max-height:calc(100dvh - 56px);border:1px solid #dfe5d6;border-radius:15px;padding:26px 30px 0;color:var(--ink);box-shadow:0 25px 100px #1c30232b;background:#fffefa}.memory-dialog::backdrop{background:#1f302b61;backdrop-filter:blur(3px)}.dialog-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}.memory-dialog h2{font-size:22px;letter-spacing:-.7px;font-weight:620}.dialog-description{font-size:12px;color:#8c9980;margin-top:10px;line-height:1.8}.dialog-form{display:grid;gap:17px;padding:23px 0}.dialog-form input,.dialog-form select,.dialog-form textarea{width:100%;font-size:12px}.dialog-form textarea{min-height:100px}.dialog-footer{display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:0;background:#fffefa;border-top:1px solid var(--line);margin:0 -30px;padding:17px 26px}.dialog-form .button{justify-self:start}.field-help{font-size:10px;color:#96a18b;line-height:1.7;margin-top:6px}.dialog-form .secret-value{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all;background:#f5f8ef;color:#506546;min-height:95px}.connection-note{background:#f5f7f0;border:1px solid #e6ebde;border-radius:7px;padding:16px}.connection-note strong{font-size:11px;font-weight:600}.connection-note p{font-size:10px;color:#8b987d;margin:10px 0 3px}.connection-note code{font-size:11px;display:block;overflow-wrap:anywhere;color:#6b7d5e}.key-list{display:grid;gap:10px;border-bottom:1px solid var(--line);padding-bottom:17px}.key-list h3{font-size:11px;font-weight:600;color:#8b9a7e}.key-row{display:flex;align-items:center;justify-content:space-between;gap:14px}.key-row strong{display:block;font-size:11px;font-weight:600;overflow-wrap:anywhere}.key-row span{display:block;font-size:9px;color:#98a38c}.key-row .text-button{font-size:10px}.noscript{padding:30px;text-align:center}.noscript a{text-decoration:underline}@media(min-width:1600px){.memory-console,.editor-form{min-height:650px}}@media(max-width:1100px){.workspace{grid-template-columns:210px minmax(0,1fr)}.sidebar{padding-inline:15px}.main-content{padding:0 25px}.memory-console{grid-template-columns:minmax(205px,36%) minmax(0,1fr)}.editor-form{padding:23px 20px 0}.editor-footer{margin-inline:-20px;padding:16px}.editor-footer>span{display:none}.editor-footer{justify-content:flex-end}.heading-actions .button{padding:10px 12px}.welcome{padding-inline:36px}.welcome-grid{gap:35px}}@media(max-width:800px){.workspace{grid-template-columns:1fr}.sidebar{min-height:auto;display:block;padding:18px 22px;border-right:0;border-bottom:1px solid var(--line)}.sidebar .brand{padding:0;font-size:18px}.brand-mark{width:30px;height:32px;font-size:20px}.sidebar-intro,.sidebar-heading,.sidebar-tools,.sidebar-bottom .storage-note,.support-link{display:none}.space-list{display:flex;overflow-x:auto;padding-top:16px;gap:6px}.space-button{width:auto;flex:none;padding:8px 12px}.sidebar-bottom{padding-top:0;position:absolute;top:17px;right:20px}.account-line{padding:0;border:0;gap:9px}.account-line>div:nth-child(2){display:none}.account-avatar{width:28px;height:28px}.main-content{padding:0 22px}.topbar{height:50px}.topbar-note{display:none}.page-heading{padding-top:27px}.page-heading h1{font-size:25px}.memory-console{min-height:540px;grid-template-columns:minmax(180px,34%) minmax(0,1fr)}.editor-form{min-height:540px}.sidebar-tools.mobile-tools{display:flex}.welcome-grid{min-height:auto;padding:70px 0;gap:25px}.welcome-copy h1{font-size:33px}.preview-note{margin:17px;padding:24px 20px}.preview-note h2{font-size:17px}.preview-bottom{padding:12px 20px 24px;gap:14px}.welcome{padding-inline:26px}}@media(max-width:600px){.sidebar{padding-inline:18px}.sidebar-tools{display:flex;overflow-x:auto;gap:10px;margin-top:14px;padding-top:10px}.sidebar-tools .sidebar-label{display:none}.nav-action{width:auto;flex:none;font-size:10px;padding:4px}.nav-action span{font-size:13px}.sidebar-heading{display:flex;position:absolute;right:68px;top:19px;padding:0}.sidebar-heading h2{display:none}.main-content{padding:0 16px}.page-heading{align-items:flex-start;gap:12px}.page-heading h1{font-size:23px;max-width:230px;overflow-wrap:anywhere}.page-heading p:not(.eyebrow){font-size:10px}.heading-actions{flex-direction:column}.heading-actions .button{font-size:10px;padding:10px 11px}.eyebrow{font-size:8px}.memory-console{display:flex;flex-direction:column}.memory-index{border-right:0;border-bottom:1px solid var(--line)}.search-form{margin:16px}.list-caption{padding-bottom:10px}.memory-list{max-height:250px;overflow-y:auto}.memory-row{padding:14px 16px}.memory-row-preview{-webkit-line-clamp:1}.memory-row-meta{margin-top:8px}.memory-row-title{font-size:12px}.editor-form{padding:22px 18px 0;min-height:520px}.editor-footer{margin-inline:-18px}.editor-empty{min-height:300px}.workspace-footer{font-size:8px;gap:14px}.welcome{padding:25px 23px 20px}.welcome-grid{grid-template-columns:1fr;padding:55px 0 35px;gap:42px}.welcome-copy h1{font-size:36px;letter-spacing:-1.8px;margin-top:19px}.welcome-description{font-size:14px}.welcome-subtitle{font-size:12px}.welcome-preview{max-width:420px;margin:0 8px}.trust-note{margin-top:20px;font-size:10px}.welcome-footer{font-size:9px;gap:12px;overflow-wrap:anywhere}.memory-dialog{padding:21px 23px 0}.dialog-footer{margin-inline:-23px;padding:16px 20px}}@media(min-width:601px) and (max-width:800px){.sidebar-tools{display:flex;overflow-x:auto;gap:12px;margin-top:14px;padding-top:10px}.sidebar-tools .sidebar-label{display:none}.nav-action{width:auto;flex:none;font-size:10px;padding:4px}.sidebar-heading{display:flex;position:absolute;right:68px;top:19px;padding:0}.sidebar-heading h2{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}`;
}
