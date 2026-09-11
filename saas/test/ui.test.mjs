import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';

let ui;
try { ui = await import('../src/ui.ts'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const brand = { name: 'Memory by Allen Labs', shortName: 'Memory', description: '팀과 에이전트가 함께 쓰는 기억', supportEmail: 'help@example.com', accentColor: '#356852' };
const workspace = {
  account: { id: 'a-one', emails: [{ id: 'e-one', address: 'alice@example.com' }] },
  spaces: [{ id: 's-one', name: '개인 메모리', organizationId: null, securityMode: 'managed', canWrite: true }],
  organizations: [{ id: 'o-one', name: '팀', role: 'admin', membershipId: 'member-one' }],
  keys: [],
};
const memory = { id: 'm-one', spaceId: 's-one', body: '첫 번째 기억\n중요한 결정', source: '회의', revision: 3, createdAt: 1700000000000, updatedAt: 1700000001000 };
async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
async function browser(t, handler = () => null, customWorkspace = workspace) {
  assert.ok(ui?.renderPage && ui?.appScript && ui?.renderStyles, 'UI exports are required');
  const dom = new JSDOM(ui.renderPage(brand), { url: 'https://memory.allenlabs.org/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  window.TextEncoder = TextEncoder;
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined, options };
    calls.push(call);
    const custom = await handler(call);
    if (custom instanceof Response) return custom;
    if (custom) return new Response(JSON.stringify(custom.body ?? {}), { status: custom.status ?? 200 });
    if (call.path === '/v1/workspace') return new Response(JSON.stringify(customWorkspace));
    if (call.path === '/v1/spaces/s-one/memories') return new Response(JSON.stringify({ results: [memory] }));
    if (call.path === '/v1/spaces/s-one/memories/m-one') return new Response(JSON.stringify(memory));
    return new Response(JSON.stringify({ results: [] }));
  };
  window.eval(ui.appScript);
  await settle();
  const byId = id => window.document.getElementById(id);
  const submit = id => byId(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const change = (id, value) => { byId(id).value = value; byId(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  return { dom, window, document: window.document, calls, byId, submit, change };
}

for(const control of ['new-space','new-organization','invite-members','accept-invite','manage-keys'])test(control+' locks every pending dialog field and restores it after failure',async t=>{
 let release,reached;const pending=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
 const f=await browser(t,call=>{if(call.method==='POST'){reached();return pending;}return null;},{...workspace,spaces:[{...workspace.spaces[0],organizationId:'o-one'}]});
 f.byId(control).click();const fields=[...f.byId('dialog-form').querySelectorAll('input,select,textarea')];assert.ok(fields.length);
 for(const field of fields)if(field.tagName!=='SELECT')field.value=field.type==='email'?'recipient@example.org':'Submitted value';
 const values=fields.map(field=>field.value);f.submit('dialog-form');await waiting;
 try{for(const field of fields)assert.equal(field.disabled,true,control+': '+field.id);}finally{release({status:500,body:{error:'temporary_failure'}});await settle();}
 await settle();assert.equal(f.byId('memory-dialog').open,true);for(const [index,field]of fields.entries()){assert.equal(field.disabled,false);assert.equal(field.value,values[index]);}assert.equal(f.byId('dialog-close').disabled,false);assert.equal(f.byId('dialog-cancel').disabled,false);assert.equal(f.byId('memory-dialog').dispatchEvent(new f.window.Event('cancel',{cancelable:true})),true);
});

test('brand configuration is escaped, CSP-compatible, and has a validated color boundary', () => {
  assert.ok(ui?.renderPage, 'UI exports are required');
  const hostile = { ...brand, name: '<img src=x onerror=alert(1)>', shortName: '<svg onload=alert(1)>', description: '"><script>alert(1)</script>', supportEmail: 'x" onclick="alert(1)@example.com' };
  const dom = new JSDOM(ui.renderPage(hostile));
  assert.equal(dom.window.document.title, hostile.name);
  assert.equal(dom.window.document.querySelectorAll('img,svg,script:not([src])').length, 0);
  assert.equal(dom.window.document.querySelectorAll('[style],style,[onclick],[onload],[onerror]').length, 0);
  assert.deepEqual([...dom.window.document.querySelectorAll('script')].map(e => e.getAttribute('src')), ['/assets/app.js']);
  assert.equal(dom.window.document.querySelector('link[rel=stylesheet]').getAttribute('href'), '/assets/app.css');
  assert.ok(dom.window.document.body.textContent.includes(hostile.shortName));
  assert.ok(dom.window.document.body.textContent.includes(hostile.name));
  assert.ok(!ui.renderStyles({ ...brand, accentColor: 'red;}body{display:none' }).includes('red;}body'));
  assert.ok(ui.renderStyles({ ...brand, accentColor: '#abc' }).includes('#abc'));
  dom.window.close();
});

test('foundation search retains its256-character input contract',async t=>{const f=await browser(t);assert.equal(f.byId('search-query').maxLength,256);});

test('external application script parses independently and signed-out users get an SSO entry', async t => {
  assert.ok(ui?.appScript, 'UI exports are required');
  assert.doesNotThrow(() => new Script(ui.appScript));
  const f = await browser(t, call => call.path === '/v1/workspace' ? { status: 401, body: { error: 'unauthorized' } } : null);
  assert.equal(f.byId('welcome').hidden, false);
  assert.equal(f.byId('workspace').hidden, true);
  assert.equal(f.document.querySelector('#sign-in').getAttribute('href'), '/auth/login');
  assert.match(f.byId('welcome').textContent, /서버.*관리/);
  assert.equal(f.window.localStorage.length, 0);
});

test('workspace renders safe user text and all editor inputs have associated labels', async t => {
  const injected = { ...memory, body: '<img src=x onerror=alert(1)>\nprivate text', source: '<svg onload=alert(1)>' };
  const f = await browser(t, call => call.path.startsWith('/v1/spaces/s-one/memories') ? { body: call.path.endsWith('/m-one') ? injected : { results: [injected] } } : null);
  assert.equal(f.byId('workspace').hidden, false);
  assert.equal(f.byId('memory-body').value, injected.body);
  assert.equal(f.byId('memory-source').value, injected.source);
  assert.equal(f.document.querySelectorAll('img,svg,[onerror],[onload]').length, 0);
  for (const id of ['memory-body', 'memory-source', 'search-query']) assert.ok(f.document.querySelector(`label[for="${id}"]`));
  assert.equal(f.byId('app-status').getAttribute('role'), 'status');
  assert.equal(f.byId('app-error').getAttribute('role'), 'alert');
  assert.equal(f.byId('memory-dialog').getAttribute('aria-labelledby'), 'dialog-title');
});

test('editing sends current revision and conflict preserves unsaved text', async t => {
  const f = await browser(t, call => call.method === 'PATCH' ? { status: 409, body: { error: 'revision_conflict' } } : null);
  f.change('memory-body', '수정한 초안');
  f.submit('editor-form');
  await settle();
  const patch = f.calls.find(c => c.method === 'PATCH');
  assert.deepEqual(patch.body, { body: '수정한 초안', source: '회의', expectedRevision: 3 });
  assert.equal(f.byId('memory-body').value, '수정한 초안');
  assert.match(f.byId('app-error').textContent, /다른|변경|충돌/);
  assert.equal(f.byId('save-memory').disabled, false);
});

test('a pending memory selection preserves edits entered before its response arrives', async t => {
  const other = { ...memory, id: 'm-two', body: '두 번째 기억', revision: 1 };
  let resolveDetail;
  const detail = new Promise(resolve => { resolveDetail = resolve; });
  const f = await browser(t, call => {
    if (call.path === '/v1/spaces/s-one/memories') return { body: { results: [memory, other] } };
    if (call.path.endsWith('/m-two')) return detail;
    if (call.method === 'PATCH') return { body: { ...memory, body: call.body.body, revision: 4 } };
    return null;
  });
  f.document.querySelectorAll('#memory-list button')[1].click();
  f.change('memory-body', '불러오는 동안 작성한 초안');
  f.change('memory-source', '새 출처');
  resolveDetail({ body: other }); await settle();
  assert.equal(f.byId('memory-body').value, '불러오는 동안 작성한 초안');
  assert.equal(f.byId('memory-source').value, '새 출처');
  assert.equal(f.byId('save-memory').disabled, false);
  f.submit('editor-form'); await settle();
  const patch = f.calls.find(call => call.method === 'PATCH');
  assert.equal(patch.path, '/v1/spaces/s-one/memories/m-one');
  assert.equal(patch.body.expectedRevision, 3);
  assert.equal(patch.body.body, '불러오는 동안 작성한 초안');
  f.document.querySelectorAll('#memory-list button')[1].click(); await settle();
  assert.equal(f.byId('memory-body').value, other.body, 'A subsequent deliberate selection can replace the saved editor');
});

test('failed memory selection leaves the original edited memory usable', async t => {
  const other = { ...memory, id: 'm-two' };
  let resolveDetail;
  const detail = new Promise(resolve => { resolveDetail = resolve; });
  const f = await browser(t, call => {
    if (call.path === '/v1/spaces/s-one/memories') return { body: { results: [memory, other] } };
    if (call.path.endsWith('/m-two')) return detail;
    return null;
  });
  f.document.querySelectorAll('#memory-list button')[1].click();
  f.change('memory-body', '연결 오류 중에도 보존할 초안');
  resolveDetail({ status: 500 }); await settle();
  assert.equal(f.byId('memory-body').value, '연결 오류 중에도 보존할 초안');
  assert.equal(f.byId('memory-body').readOnly, false);
  assert.equal(f.byId('save-memory').disabled, false);
  assert.equal(f.byId('app-error').hidden, false);
});

for (const outcome of ['success', 'network failure', 'logout']) test('workspace refresh protects editor intent until ' + outcome, async t => {
  let reads = 0, resolveRefresh;
  const pending = new Promise(resolve => { resolveRefresh = resolve; });
  const f = await browser(t, call => {
    if (call.path === '/v1/workspace' && ++reads > 1) return pending;
    if (call.path === '/v1/spaces' && call.method === 'POST') return { body: { id: 's-new' } };
    if (call.path === '/auth/logout') return { status: 200 };
    return null;
  });
  f.change('memory-body', '보존할 초안');
  f.byId('new-space').click(); f.byId('field-name').value = '새 공간'; f.submit('dialog-form'); await settle();
  assert.equal(f.byId('memory-dialog').open, false);
  for (const id of ['memory-body', 'memory-source']) assert.equal(f.byId(id).readOnly, true, id + ' cannot accept edits before destination selection');
  for (const id of ['save-memory', 'new-memory', 'new-space']) assert.equal(f.byId(id).disabled, true);
  assert.equal(f.byId('memory-body').value, '보존할 초안');
  if (outcome === 'logout') { f.byId('logout').click(); await settle(); }
  resolveRefresh(outcome === 'network failure' ? { status: 500 } : { body: { ...workspace, spaces: [...workspace.spaces, { ...workspace.spaces[0], id: 's-new', name: '새 공간' }] } });
  await settle();
  if (outcome === 'logout') {
    assert.equal(f.byId('workspace').hidden, true);
    assert.equal(f.byId('memory-body').value, '');
  } else {
    assert.equal(f.byId('workspace').hidden, false);
    assert.equal(f.byId('new-memory').disabled, false);
    assert.equal(f.byId('memory-body').readOnly, false);
    if (outcome === 'success') assert.equal(f.byId('space-title').textContent, '새 공간');
    else {
      assert.equal(f.byId('memory-body').value, '보존할 초안');
      assert.equal(f.byId('save-memory').disabled, false);
      assert.equal(f.byId('app-error').hidden, false);
    }
  }
});

test('read-only spaces keep content accessible and disable all memory mutations', async t => {
  const readonly = { ...workspace, spaces: [{ ...workspace.spaces[0], canWrite: false, organizationId: 'o-one' }] };
  const f = await browser(t, () => null, readonly);
  assert.equal(f.byId('memory-body').readOnly, true);
  for (const id of ['new-memory', 'save-memory', 'delete-memory']) assert.equal(f.byId(id).disabled, true);
  f.submit('editor-form');
  await settle();
  assert.ok(!f.calls.some(c => c.method === 'PATCH' || c.method === 'POST'));
});

test('creating and deleting memories use their API contracts and expected revision', async t => {
  const f = await browser(t, call => {
    if (call.method === 'POST') return { body: { ...memory, id: 'm-new', body: call.body.body, source: call.body.source, revision: 1 } };
    if (call.method === 'DELETE') return { status: 200, body: {} };
    return null;
  });
  f.byId('new-memory').click();
  f.change('memory-body', '새 기록');
  f.change('memory-source', '');
  f.submit('editor-form');
  await settle();
  const create = f.calls.find(c => c.method === 'POST');
  assert.equal(create.path, '/v1/spaces/s-one/memories');
  assert.deepEqual(create.body, { body: '새 기록', source: null });
  f.byId('delete-memory').click();
  await settle();
  const remove = f.calls.find(c => c.method === 'DELETE');
  assert.equal(remove.path, '/v1/spaces/s-one/memories/m-new');
  assert.deepEqual(remove.body, { expectedRevision: 1 });
});

test('search sends an encoded query and pagination consumes the opaque cursor', async t => {
  const f = await browser(t, call => call.path === '/v1/spaces/s-one/memories' ? { body: { results: [memory], nextCursor: 'opaque+/=' } } : null);
  f.byId('load-more').click();
  await settle();
  assert.ok(f.calls.some(c => c.path === '/v1/spaces/s-one/memories?cursor=opaque%2B%2F%3D'));
  f.change('search-query', 'a & b');
  f.submit('search-form');
  await settle();
  assert.ok(f.calls.some(c => c.path === '/v1/spaces/s-one/memories?query=a%20%26%20b'));
});

test('key issuance shows a secret once and closing clears it without browser storage', async t => {
  const f = await browser(t, call => call.path === '/v1/keys' && call.method === 'POST' ? { body: { id: 'key-one', token: 'secret-key-value', expiresAt: 1800000000000 } } : null);
  f.byId('manage-keys').click();
  f.change('field-label', '개발 에이전트');
  f.submit('dialog-form');
  await settle();
  const issue = f.calls.find(c => c.path === '/v1/keys' && c.method === 'POST');
  assert.equal(issue.body.label, '개발 에이전트');
  assert.equal(issue.body.permission, 'read');
  assert.equal(issue.body.expiresInDays, 30);
  assert.equal(f.byId('issued-secret').value, 'secret-key-value');
  assert.match(f.byId('memory-dialog').textContent, /memory\.allenlabs\.org\/mcp/);
  f.byId('dialog-close').click();
  assert.equal(f.byId('issued-secret'), null);
  assert.ok(!f.document.documentElement.textContent.includes('secret-key-value'));
  assert.equal(f.window.localStorage.length, 0);
  assert.equal(f.window.sessionStorage.length, 0);
});

test('organization and invitation forms bind explicit email claims and preserve token-only acceptance', async t => {
  const f = await browser(t, call => call.method === 'POST' ? { body: { id: 'o-new', name: '새 팀', spaceId: 's-one', organizationId: 'o-new' } } : null);
  f.byId('new-organization').click();
  f.change('field-name', '새 팀');
  f.submit('dialog-form');
  await settle();
  assert.deepEqual(f.calls.find(c => c.path === '/v1/organizations').body, { name: '새 팀', emailId: 'e-one' });
  f.byId('accept-invite').click();
  f.change('field-token', 'copyable-invitation-token');
  f.submit('dialog-form');
  await settle();
  assert.deepEqual(f.calls.find(c => c.path === '/v1/invitations/accept').body, { token: 'copyable-invitation-token' });
});

test('logout accepts the redirected HTML response and clears the private workspace', async t => {
  const f = await browser(t, call => call.path === '/auth/logout' ? new Response('<!doctype html><title>Signed out</title>', { headers: { 'Content-Type': 'text/html' } }) : null);
  f.byId('logout').click();
  await settle();
  assert.equal(f.calls.find(call => call.path === '/auth/logout').method, 'POST');
  assert.equal(f.byId('workspace').hidden, true);
  assert.equal(f.byId('welcome').hidden, false);
  assert.equal(f.byId('memory-body').value, '');
});

test('pending key issuance keeps its dialog and secret until the response can be copied', async t => {
  let finishIssue;
  const f = await browser(t, call => call.path === '/v1/keys' && call.method === 'POST' ? new Promise(resolve => { finishIssue = resolve; }) : null);
  f.byId('manage-keys').click();
  f.change('field-label', '닫힐 키');
  f.submit('dialog-form');
  await settle();
  f.byId('dialog-close').click();
  f.byId('accept-invite').click();
  finishIssue({ body: { id: 'key-late', token: 'late-secret-value', expiresAt: 1800000000000 } });
  await settle();
  assert.equal(f.byId('issued-secret')?.value, 'late-secret-value');
  assert.equal(f.byId('field-token'), null);
  assert.equal(f.byId('dialog-close').disabled,false);
  f.byId('dialog-close').click();assert.equal(f.byId('memory-dialog').open,false);assert.equal(f.byId('issued-secret'),null);
});

test('organization admins can remove an explicit membership and ordinary members cannot open controls', async t => {
  const f = await browser(t, call => call.path === '/v1/organizations/o-one/members' ? { body: { results: [{ id: 'membership-bob', accountId: 'bob', email: 'bob@example.com', role: 'member', expiresAt: Number.MAX_SAFE_INTEGER }] } } : call.method === 'DELETE' ? { body: {} } : null);
  assert.ok(f.byId('manage-members'), 'Member management control is required');
  f.byId('manage-members').click();
  await settle();
  assert.match(f.byId('members-list').textContent, /bob@example\.com/);
  const remove = f.byId('members-list').querySelector('button');
  remove.click();
  await settle();
  assert.ok(f.calls.some(call => call.method === 'DELETE' && call.path === '/v1/organizations/o-one/memberships/membership-bob'));
  assert.ok(!f.byId('members-list').textContent.includes('bob@example.com'));
  const member = await browser(t, () => null, { ...workspace, organizations: [{ ...workspace.organizations[0], role: 'member' }] });
  assert.equal(member.byId('manage-members').hidden, true);
  member.byId('manage-members').click();
  assert.equal(member.byId('memory-dialog').open, false);
});

test('owner controls retain a pending removal lock when another membership removal finishes', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const members = [{ id: 'self', accountId: 'a-one', role: 'owner' }, { id: 'other-owner', accountId: 'bob', role: 'owner' }, { id: 'ordinary', accountId: 'carol', role: 'member' }];
  const f = await browser(t, call => call.path.endsWith('/members') ? { body: { results: members } } : call.path.endsWith('/memberships/other-owner') ? held : call.method === 'DELETE' ? { body: {} } : null, { ...workspace, organizations: [{ ...workspace.organizations[0], role: 'owner' }] });
  f.byId('manage-members').click(); await settle();
  const buttons = [...f.byId('members-list').querySelectorAll('button')], owner = buttons.find(button => button.getAttribute('aria-label').startsWith('bob')), ordinary = buttons.find(button => button.getAttribute('aria-label').startsWith('carol'));
  owner.click(); await settle(); ordinary.click(); await settle();
  try { assert.equal(owner.disabled, true); } finally { release({ body: {} }); }
  await settle();
});

for (const discard of [false, true]) test('self-removal requires explicit draft discard: ' + discard, async t => {
  let revoked = false;
  const f = await browser(t, call => {
    if (call.path === '/v1/organizations/o-one/members') return { body: { results: [{ id: 'membership-self', accountId: workspace.account.id, email: 'alice@example.com', role: 'admin' }] } };
    if (call.method === 'DELETE') { revoked = true; return { body: {} }; }
    if (call.path === '/v1/workspace' && revoked) return { body: { ...workspace, organizations: [] } };
    return null;
  });
  f.change('memory-body', '다른 개인 공간의 저장하지 않은 초안');
  f.change('memory-source', '저장하지 않은 출처');
  const prompts = [];
  f.window.confirm = message => { prompts.push(message); return message.includes('저장하지 않은') ? discard : true; };
  f.byId('manage-members').click(); await settle();
  f.byId('members-list').querySelector('button').click(); await settle();
  assert.ok(prompts.some(message => message.includes('저장하지 않은')), 'Self-removal refresh must explicitly confirm discarding the unrelated personal draft');
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, discard ? 1 : 0);
  assert.equal(f.byId('memory-body').value, discard ? memory.body : '다른 개인 공간의 저장하지 않은 초안');
  assert.equal(f.byId('memory-source').value, discard ? memory.source : '저장하지 않은 출처');
  assert.equal(f.byId('memory-dialog').open, !discard);
  assert.equal(f.byId('manage-members').hidden, discard);
  assert.equal(f.byId('save-memory').disabled, false);
});

test('space creation chooses an explicit organization and always requests managed storage', async t => {
  const f = await browser(t, call => call.path === '/v1/spaces' && call.method === 'POST' ? { body: { id: 's-new', name: call.body.name, organizationId: call.body.organizationId, securityMode: 'managed' } } : null);
  f.byId('new-space').click();
  f.change('field-name', '프로젝트 공간');
  f.change('field-organizationId', 'o-one');
  f.submit('dialog-form');
  await settle();
  assert.deepEqual(f.calls.find(call => call.path === '/v1/spaces' && call.method === 'POST').body, { name: '프로젝트 공간', organizationId: 'o-one', securityMode: 'managed' });
  assert.equal(f.byId('memory-dialog').open, false);
});

test('admin invitation creation returns a manually shared code for the explicit email and role', async t => {
  const team = { ...workspace, spaces: [{ ...workspace.spaces[0], organizationId: 'o-one' }] };
  const f = await browser(t, call => call.path === '/v1/organizations/o-one/invites' ? { body: { id: 'invite-one', token: 'manual-invitation-code', expiresAt: 1800000000000 } } : null, team);
  assert.equal(f.byId('invite-members').hidden, false);
  f.byId('invite-members').click();
  f.change('field-email', 'new@example.com');
  f.change('field-role', 'admin');
  f.submit('dialog-form');
  await settle();
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/invites')).body, { email: 'new@example.com', role: 'admin' });
  assert.equal(f.byId('issued-secret').value, 'manual-invitation-code');
  assert.match(f.byId('dialog-description').textContent, /직접.*이메일.*발송되지/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  f.byId('dialog-close').click();
  assert.equal(f.byId('issued-secret'), null);
});

test('existing machine keys can be revoked and known last-owner removal is explained without a doomed request', async t => {
  const withKey = { ...workspace, keys: [{ id: 'key-old', label: 'Old agent', permission: 'read', expiresAt: 1800000000000, revokedAt: null }] };
  const f = await browser(t, call => call.path === '/v1/keys/key-old' && call.method === 'DELETE' ? { body: {} } : call.path === '/v1/organizations/o-one/members' ? { body: { results: [{ id: 'm-owner', accountId: 'a-one', email: 'owner@example.com', role: 'owner', expiresAt: Number.MAX_SAFE_INTEGER }] } } : call.path.endsWith('/memberships/m-owner') ? { status: 403 } : null, withKey);
  f.byId('manage-keys').click();
  f.byId('dialog-form').querySelector('.key-list button').click();
  await settle();
  assert.ok(f.calls.some(call => call.path === '/v1/keys/key-old' && call.method === 'DELETE'));
  assert.ok(!f.byId('dialog-form').textContent.includes('Old agent'));
  f.byId('dialog-close').click();
  f.byId('manage-members').click();
  await settle();
  const remove = f.byId('members-list').querySelector('button');
  remove.click();
  await settle();
  assert.equal(remove.disabled, true);
  assert.equal(f.byId('dialog-error').hidden, true);
  assert.equal(f.calls.some(call => call.path.endsWith('/memberships/m-owner')), false);
  assert.match(f.byId('members-list').textContent, /마지막 소유자/);
  assert.match(f.byId('members-list').textContent, /owner@example\.com/);
});

test('the editor rejects NUL and UTF-8 byte overflow before sending a mutation', async t => {
  const f = await browser(t);
  for (const [body, source] of [['before\u0000hidden', ''], ['Valid', '\u0000source'], ['한'.repeat(5462), ''], ['Valid', '한'.repeat(683)]]) {
    f.change('memory-body', body); f.change('memory-source', source); f.submit('editor-form'); await settle();
    assert.equal(f.byId('app-error').hidden, false);
  }
  assert.ok(!f.calls.some(call => call.method === 'POST' || call.method === 'PATCH'));
});

test('session expiry preserves a draft and reconnect verifies the same account before retrying its revision', async t => {
  let renewed = false;
  const f = await browser(t, call => call.method === 'PATCH' ? renewed ? { body: { ...memory, ...call.body, revision: 4 } } : { status: 401 } : null);
  f.change('memory-body', '만료되어도 남아야 할 초안'); f.change('memory-source', '보관할 출처');
  f.submit('editor-form'); await settle();
  assert.equal(f.byId('memory-body').value, '만료되어도 남아야 할 초안');
  assert.equal(f.byId('memory-source').value, '보관할 출처');
  assert.equal(f.byId('workspace').hidden, false);
  assert.equal(f.byId('save-memory').disabled, true);
  assert.equal(f.byId('reauthenticate').getAttribute('href'), '/auth/login');
  assert.equal(f.byId('reauthenticate').getAttribute('target'), '_blank');
  assert.ok(f.byId('reauthenticate').getAttribute('rel').split(' ').includes('noopener'));
  f.submit('editor-form'); await settle();
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  renewed = true; f.byId('resume-session').click(); await settle();
  assert.equal(f.byId('memory-body').value, '만료되어도 남아야 할 초안');
  assert.equal(f.byId('save-memory').disabled, false);
  f.submit('editor-form'); await settle();
  const mutations = f.calls.filter(call => call.method === 'PATCH');
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[1].body, { body: '만료되어도 남아야 할 초안', source: '보관할 출처', expectedRevision: 3 });
  assert.ok(f.calls.filter(call => call.path === '/v1/workspace').length >= 3);
  const retryIndex = f.calls.indexOf(mutations[1]);
  assert.equal(f.calls[retryIndex - 1].path, '/v1/workspace');
  assert.equal(f.window.localStorage.length, 0); assert.equal(f.window.sessionStorage.length, 0);
});

test('reconnecting a different account clears the draft even when it can access the same team Space', async t => {
  let switched = false;
  const f = await browser(t, call => call.method === 'PATCH' ? { status: 401 } : switched && call.path === '/v1/workspace' ? { body: { ...workspace, account: { id: 'other-account', emails: [] } } } : null);
  f.change('memory-body', '원래 계정의 초안'); f.submit('editor-form'); await settle();
  assert.equal(f.byId('memory-body').value, '원래 계정의 초안');
  switched = true; f.byId('resume-session').click(); await settle();
  assert.equal(f.byId('memory-body').value, '');
  assert.equal(f.byId('memory-source').value, '');
  assert.equal(f.byId('workspace').hidden, true);
  assert.match(f.byId('welcome-error').textContent, /다른 계정/);
  f.submit('editor-form'); await settle();
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('a recovered draft rechecks identity at save time after another tab switches accounts', async t => {
  let switched = false;
  const f = await browser(t, call => call.method === 'PATCH' ? { status: 401 } : switched && call.path === '/v1/workspace' ? { body: { ...workspace, account: { id: 'other-account', emails: [] } } } : null);
  f.change('memory-body', '다른 계정으로 보내면 안 되는 초안'); f.submit('editor-form'); await settle();
  assert.ok(f.byId('resume-session'), 'Reconnect control is required');
  f.byId('resume-session').click(); await settle();
  assert.equal(f.byId('save-memory').disabled, false);
  switched = true; f.submit('editor-form'); await settle();
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(f.byId('memory-body').value, '');
  assert.equal(f.byId('workspace').hidden, true);
});

for (const access of ['missing', 'read-only']) {
  test(`reconnecting with ${access} Space access preserves text but does not permit a retry`, async t => {
    let changed = false;
    const f = await browser(t, call => call.method === 'PATCH' ? { status: 401 } : changed && call.path === '/v1/workspace' ? { body: { ...workspace, spaces: access === 'missing' ? [] : [{ ...workspace.spaces[0], canWrite: false }] } } : null);
    f.change('memory-body', '복사할 수 있게 남겨 둘 초안'); f.submit('editor-form'); await settle();
    assert.ok(f.byId('resume-session'), 'Reconnect control is required');
    changed = true; f.byId('resume-session').click(); await settle();
    assert.equal(f.byId('memory-body').value, '복사할 수 있게 남겨 둘 초안');
    assert.equal(f.byId('save-memory').disabled, true);
    f.submit('editor-form'); await settle();
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(f.byId('app-error').hidden, false);
  });
}

test('new-memory expiry preserves text and explicit logout clears it despite a late reconnect response', async t => {
  let finishReconnect, waiting = false;
  const f = await browser(t, call => call.path === '/auth/logout' ? new Response('<title>Signed out</title>') : call.method === 'POST' ? { status: 401 } : waiting && call.path === '/v1/workspace' ? new Promise(resolve => { finishReconnect = resolve; }) : null);
  f.byId('new-memory').click(); f.change('memory-body', '저장 전 새 메모리'); f.submit('editor-form'); await settle();
  assert.equal(f.byId('memory-body').value, '저장 전 새 메모리');
  waiting = true; f.byId('resume-session').click(); await settle();
  f.byId('logout').click(); await settle();
  finishReconnect({ body: workspace }); await settle();
  assert.equal(f.byId('memory-body').value, ''); assert.equal(f.byId('workspace').hidden, true);
  assert.equal(f.window.localStorage.length, 0); assert.equal(f.window.sessionStorage.length, 0);
});

test('organization creation sends only a selected manageable parent and explains independent access', async t => {
  const hierarchy = { ...workspace, organizations: [...workspace.organizations, { id: 'o-member', name: '읽기만 가능한 조직', role: 'member', membershipId: 'm-read' }] };
  const f = await browser(t, call => call.path === '/v1/organizations' ? { body: { id: 'child', spaceId: 's-one' } } : null, hierarchy);
  f.byId('new-organization').click();
  assert.ok(f.byId('field-parentOrganizationId'), 'Parent organization selection is required');
  assert.deepEqual([...f.byId('field-parentOrganizationId').options].map(option => option.value), ['', 'o-one']);
  assert.match(f.byId('dialog-form').textContent, /멤버십.*접근.*상속되지/);
  f.change('field-name', '하위 조직'); f.change('field-parentOrganizationId', 'o-one'); f.submit('dialog-form'); await settle();
  assert.deepEqual(f.calls.find(call => call.path === '/v1/organizations').body, { name: '하위 조직', emailId: 'e-one', parentOrganizationId: 'o-one' });
});

test('team descriptions show only a parent organization already present in the workspace', async t => {
  const child = { ...workspace, spaces: [{ ...workspace.spaces[0], organizationId: 'o-child' }], organizations: [{ ...workspace.organizations[0], name: '상위 팀' }, { id: 'o-child', name: '하위 팀', parentId: 'o-one', role: 'admin', membershipId: 'child-member' }] };
  const f = await browser(t, () => null, child);
  assert.match(f.byId('space-description').textContent, /상위 팀/);
  const hidden = await browser(t, () => null, { ...child, organizations: [{ ...child.organizations[1], parentId: null }] });
  assert.ok(!hidden.byId('space-description').textContent.includes('상위 팀'));
});
