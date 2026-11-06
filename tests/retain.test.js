const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'retain.js'), 'utf8');
const pdf = '%PDF-1.7\nmock PDF body';
const hash = createHash('sha256').update(pdf).digest('hex');

function setup({ config = {}, foreignGateway = false } = {}) {
  const runtime = {
    xApiKey: 'retain-pdf-desktop',
    apiBase: 'http://127.0.0.1:41000',
    ocrProvider: 'paddle',
    ocrCredentialRef: 'ocr-ref',
    paddleToken: 'ignored-ocr-token',
    translationCredentialRef: 'translation-ref',
    modelApiKey: 'ignored-model-key',
    model: 'base-model',
    baseUrl: 'https://example.test/v1',
    developerConfig: { model: 'chosen-model' },
    ...config,
  };
  const record = {
    path: '/mock/paper.pdf',
    filename: '论文.pdf',
    title: '论文标题',
    groups: [['主题', '子组'], ['交叉'] ],
  };
  const state = {
    collections: [],
    memberships: new Map(),
    checkpoints: [],
    calls: [],
    jobs: [],
    uploadCount: 0,
    submitCount: 0,
  };
  const json = (data) => Response.json({ code: 0, data });

  async function fakeFetch(url, options) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'http://127.0.0.1:40001');
    const route = endpoint.pathname;
    const method = options.method || 'GET';
    state.calls.push(`${method} ${route}`);
    if (route === '/index.html' || route === '/') {
      return new Response(foreignGateway ? '<!doctype html>other app' : `
        <script src="dist/app.bundle.js"></script>
        <script>window.__FRONT_RUNTIME_CONFIG__=Object.assign({},window.__FRONT_RUNTIME_CONFIG__||{},${JSON.stringify(runtime)});</script>
      `);
    }

    assert.equal(options.headers['X-API-Key'], 'retain-pdf-desktop');
    const apiRoute = route.replace(/^\/api\/v1\//, '');
    if (options.body && !(options.body instanceof Blob)) {
      assert.equal(options.headers['Content-Type'], 'application/json');
    }
    if (method === 'POST' && apiRoute === 'uploads') {
      assert.ok(options.body instanceof Blob);
      const multipart = await new Response(options.body).formData();
      assert.deepEqual([...multipart.keys()], ['file']);
      const attachment = multipart.get('file');
      assert.equal(attachment.name, record.filename);
      assert.equal(attachment.type, 'application/pdf');
      assert.equal(await attachment.text(), pdf);
      state.uploadCount += 1;
      state.document = { document_id: hash, source_filename: record.filename, title: 'file title' };
      if (state.loseUploadResponse) throw new Error('upload reply lost');
      return json({ upload_id: 'upload-1', document_id: hash });
    }

    const payload = options.body && JSON.parse(options.body);
    if (apiRoute === 'collections' && method === 'GET') {
      return json({ collections: state.collections });
    }
    if (apiRoute === 'collections' && method === 'POST') {
      if (payload.parent_id) {
        assert.ok(state.collections.some((row) => row.collection_id === payload.parent_id));
      }
      const row = { ...payload, collection_id: `collection-${state.collections.length + 1}` };
      state.collections.push(row);
      return json(row);
    }
    if (method === 'POST' && apiRoute.startsWith('collections/')) {
      const [, collection, suffix] = apiRoute.split('/');
      assert.equal(suffix, 'documents');
      assert.deepEqual(payload, { document_ids: [hash] });
      if (state.failMembership) return Response.json({ code: 1 }, { status: 503 });
      state.memberships.set(collection, hash);
      return json({ added: 1 });
    }
    if (apiRoute === `documents/${hash}` && method === 'GET') {
      return state.document ? json(state.document) : Response.json({ code: 1 }, { status: 404 });
    }
    if (apiRoute === `documents/${hash}` && method === 'PATCH') {
      state.document.title = payload.title;
      return json(state.document);
    }
    if (apiRoute === `documents/${hash}/jobs` && method === 'GET') {
      return json({ items: state.jobs, has_more: false });
    }
    if (apiRoute === `documents/${hash}/translate` && method === 'POST') {
      assert.equal(state.memberships.size, record.groups.length || 1);
      state.submitCount += 1;
      state.request = payload;
      const job = { job_id: 'job-1', status: 'queued', workflow: payload.workflow };
      state.jobs.push(job);
      if (state.loseSubmitResponse) throw new Error('submit reply lost');
      return json(job);
    }
    throw new Error(`Unexpected mock call ${method} ${route}`);
  }

  const context = vm.createContext({
    fetch: fakeFetch,
    Blob,
    crypto: webcrypto,
    File: { createFromFileName: async (filename) => {
      assert.equal(filename, record.path);
      return new Blob([pdf], { type: 'application/pdf' });
    } },
    Zotero: { getMainWindow: () => ({ AbortController }) },
    clearTimeout,
    setTimeout,
  });
  const retainSync = vm.runInContext(source + '\nretainSync', context);
  const sync = () => retainSync(record, async () => state.checkpoints.push(structuredClone(record)));
  return { record, runtime, state, sync };
}

test('reuses exact collection paths, creates a missing child, and queues full translation', async () => {
  const { record, state, sync } = setup();
  state.collections.push(
    { collection_id: 'subject', name: '主题', parent_id: null },
    { collection_id: 'cross', name: '交叉', parent_id: null },
    { collection_id: 'other-child', name: '子组', parent_id: 'cross' },
  );
  await sync();
  await sync();
  assert.equal(record.documentId, hash);
  assert.equal(record.jobId, 'job-1');
  assert.equal(state.uploadCount, 1);
  assert.equal(state.submitCount, 1);
  assert.deepEqual(state.collections.map(({ name, parent_id }) => [name, parent_id]), [
    ['主题', null], ['交叉', null], ['子组', 'cross'], ['子组', 'subject'],
  ]);
  assert.deepEqual([...state.memberships.keys()], ['collection-4', 'cross']);
  assert.equal(state.document.title, record.title);
  assert.equal(state.request.workflow, 'book');
  assert.deepEqual(state.request.source, {});
  assert.equal(state.request.ocr.credential_ref, 'ocr-ref');
  assert.equal(state.request.ocr.paddle_token, undefined);
  assert.equal(state.request.translation.credential_ref, 'translation-ref');
  assert.equal(state.request.translation.api_key, undefined);
  assert.equal(state.request.translation.model, 'chosen-model');
  assert.equal(state.request.translation.base_url, 'https://example.test/v1');
  assert.equal(state.request.render.render_mode, 'auto');
});

test('recovers committed uploads and jobs when their responses are lost', async () => {
  const { record, state, sync } = setup();
  state.loseUploadResponse = true;
  await assert.rejects(sync, /upload reply lost/);
  assert.equal(state.checkpoints[0].uploadHash, hash);
  assert.equal(record.documentId, undefined);

  state.loseSubmitResponse = true;
  await assert.rejects(sync, /submit reply lost/);
  assert.equal(record.documentId, hash);
  assert.equal(record.groupedAtOriginalPath, true);
  assert.equal(record.jobId, undefined);

  await sync();
  assert.equal(record.jobId, 'job-1');
  assert.equal(state.uploadCount, 1);
  assert.equal(state.submitCount, 1);
  assert.equal(state.collections.length, 3);
});

test('recognizes existing original and translation while adding uncategorized membership', async () => {
  const { record, state, sync } = setup();
  record.groups = [];
  state.document = { document_id: hash, title: 'RetainPDF title', title_locked: true };
  state.jobs.push({ job_id: 'previous', workflow: 'translate', status: 'succeeded' });
  await sync();
  assert.equal(record.jobId, 'previous');
  assert.equal(state.document.title, 'RetainPDF title');
  assert.equal(state.uploadCount, 0);
  assert.equal(state.submitCount, 0);
  assert.deepEqual(state.collections.map((row) => row.name), ['未分类']);
  assert.equal(state.memberships.get('collection-1'), hash);
});

test('resumes older pending records and waits for collection membership before submitting', async () => {
  const { record, state, sync } = setup();
  record.grouped = true;
  state.failMembership = true;
  await assert.rejects(sync, /HTTP 503/);
  assert.equal(record.groupedAtOriginalPath, undefined);
  assert.equal(state.submitCount, 0);
  state.failMembership = false;
  await sync();
  assert.equal(state.collections.length, 3);
  assert.equal(state.uploadCount, 1);
  assert.equal(state.submitCount, 1);
});

test('holds the pending translation until credentials are configured', async () => {
  const { record, runtime, state, sync } = setup({ config: { modelApiKey: '', translationCredentialRef: '' } });
  await assert.rejects(sync, /配置翻译模型/);
  assert.equal(record.groupedAtOriginalPath, true);
  assert.equal(state.uploadCount, 1);
  assert.equal(state.submitCount, 0);
  runtime.translationCredentialRef = 'translation-ref';
  await sync();
  assert.equal(state.uploadCount, 1);
  assert.equal(state.submitCount, 1);
});

test('refuses to send PDFs to a service without the desktop gateway markers', async () => {
  const { state, sync } = setup({ foreignGateway: true });
  await assert.rejects(sync, /未提供 RetainPDF/);
  assert.equal(state.calls.length, 1);
  assert.equal(state.uploadCount, 0);
});
