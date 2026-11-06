// The RetainPDF desktop gateway proxies these requests to its own backend.
const retainGateway = "http://127.0.0.1:40001";
const retainDesktopKey = "retain-pdf-desktop";
const retainRetryDelay = 5 * 60 * 1000;
let retainLastLaunch = 0;

async function retainFetch(path, options = {}, timeout = 15000) {
  const controller = Zotero.getMainWindow()?.AbortController;
  const abort = controller ? new controller() : null;
  let timer;
  try {
    return await Promise.race([
      fetch(retainGateway + path, {
        ...options,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        ...(abort ? { signal: abort.signal } : {}),
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort?.abort();
          reject(new Error("RetainPDF 响应超时"));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function retainConfig() {
  let response;
  try {
    response = await retainFetch("/index.html");
  } catch (error) {
    if (Zotero.isMac && Date.now() - retainLastLaunch >= retainRetryDelay) {
      retainLastLaunch = Date.now();
      await Zotero.Utilities.Internal.exec("/usr/bin/open", ["-g", "/Applications/RetainPDF.app"]);
    }
    throw new Error("正在等待 RetainPDF 桌面服务");
  }
  if (!response.ok) throw new Error("RetainPDF 桌面服务尚未就绪");
  const html = await response.text();
  const injected = html.match(/__FRONT_RUNTIME_CONFIG__\s*\|\|\s*\{\}\s*,\s*(\{[^\r\n]*\})\);<\/script>/);
  if (!injected || !html.includes("dist/app.bundle.js")) {
    throw new Error("端口 40001 未提供 RetainPDF 桌面服务");
  }
  const config = JSON.parse(injected[1]);
  if (config.xApiKey !== retainDesktopKey || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(config.apiBase)) {
    throw new Error("无法识别 RetainPDF 桌面配置");
  }
  return config;
}

async function retainRequest(path, method = "GET", payload) {
  const headers = { "X-API-Key": retainDesktopKey };
  let body = payload;
  const upload = payload instanceof Blob;
  if (payload !== undefined && !upload) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  const response = await retainFetch("/api/v1/" + path, { method, headers, body }, upload ? 120000 : 30000);
  if (!response.ok) {
    const error = new Error("RetainPDF " + method + " " + path.split("?")[0] + " 返回 HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (result?.code !== undefined) {
    if (result.code !== 0) {
      throw new Error("RetainPDF " + method + " " + path.split("?")[0] + " 请求失败");
    }
    return result.data;
  }
  return result;
}

function retainTranslation(config) {
  const provider = config.ocrProvider === "mineru" ? "mineru" : "paddle";
  const tokenField = provider === "mineru" ? "mineru_token" : "paddle_token";
  const token = provider === "mineru" ? config.mineruToken : config.paddleToken;
  const ocr = { provider, model_version: "vlm", language: "ch" };
  if (provider === "paddle") ocr.paddle_api_url = "https://paddleocr.aistudio-app.com";
  if (config.ocrCredentialRef) ocr.credential_ref = config.ocrCredentialRef;
  else if (token) ocr[tokenField] = token;
  else throw new Error("请在 RetainPDF 中配置 OCR 凭据");

  const translation = {
    model: config.developerConfig?.model || config.model,
    base_url: config.developerConfig?.baseUrl || config.baseUrl,
    mode: "sci",
    rule_profile_name: "general_sci",
  };
  if (config.translationCredentialRef) translation.credential_ref = config.translationCredentialRef;
  else if (config.modelApiKey) translation.api_key = config.modelApiKey;
  else throw new Error("请在 RetainPDF 中配置翻译模型的 API 凭据");
  return { workflow: "book", source: {}, ocr, translation, render: { render_mode: "auto" } };
}

async function retainUpload(file, filename) {
  const boundary = "zotero-retain-" + crypto.randomUUID();
  const sourceName = filename.replace(/["\\/\x00-\x1f\x7f]/g, "_");
  const body = new Blob([
    "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + sourceName
      + "\"\r\nContent-Type: application/pdf\r\n\r\n",
    file,
    "\r\n--" + boundary + "--\r\n",
  ], { type: "multipart/form-data; boundary=" + boundary });
  return retainRequest("uploads", "POST", body);
}

async function retainGetDocument(record, checkpoint) {
  if (record.documentId) return record.documentId;

  const file = await File.createFromFileName(record.path, { type: "application/pdf" });
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let document;
  try {
    document = await retainRequest("documents/" + hash);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!document) {
    // RetainPDF uses the original content hash as its document ID.
    record.uploadHash = hash;
    await checkpoint();
    try {
      document = await retainUpload(file, record.filename || "Zotero.pdf");
    } catch (error) {
      if ([413, 415, 422].includes(error.status)) error.permanent = true;
      throw error;
    }
  }
  if (!document?.document_id) throw new Error("RetainPDF 未返回文档 ID");
  record.documentId = document.document_id;
  await checkpoint();
  return record.documentId;
}

async function retainGroup(record, documentPath) {
  const paths = record.groups?.length ? record.groups : [["未分类"]];
  const { collections } = await retainRequest("collections");
  const documentIds = { document_ids: [record.documentId] };

  for (const path of paths) {
    let parent = null;
    for (const name of path) {
      let collection = collections.find((row) => row.name === name && (row.parent_id || null) === parent);
      if (!collection) {
        collection = await retainRequest("collections", "POST", { name, parent_id: parent });
        collections.push(collection);
      }
      if (!collection?.collection_id) throw new Error("RetainPDF 未返回合集 ID");
      parent = collection.collection_id;
    }
    await retainRequest("collections/" + encodeURIComponent(parent) + "/documents", "POST", documentIds);
  }
  if (record.title && record.uploadHash) {
    const document = await retainRequest(documentPath);
    if (!document.title_locked && document.title !== record.title) {
      await retainRequest(documentPath, "PATCH", { title: record.title });
    }
  }
}

async function retainSync(record, checkpoint) {
  if (record.jobId) return;
  const config = await retainConfig();
  const id = await retainGetDocument(record, checkpoint);
  const documentPath = "documents/" + encodeURIComponent(id);
  if (!record.groupedAtOriginalPath) {
    await retainGroup(record, documentPath);
    record.groupedAtOriginalPath = true;
    await checkpoint();
  }

  const { items } = await retainRequest(documentPath + "/jobs?limit=50");
  // RetainPDF owns retries for an accepted job, including failed translations.
  let job = items.find((item) => ["book", "translate"].includes(item.workflow || item.job_type) && item.job_id);
  if (!job && record.submitStarted && Date.now() - record.submitStarted < retainRetryDelay) {
    throw new Error("正在确认 RetainPDF 是否已接收翻译任务");
  }
  if (!job) {
    const request = retainTranslation(config);
    record.submitStarted = Date.now();
    await checkpoint();
    try {
      job = await retainRequest(documentPath + "/translate", "POST", request);
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) {
        delete record.submitStarted;
        await checkpoint();
      }
      throw error;
    }
  }
  if (!job?.job_id) throw new Error("RetainPDF 未返回任务 ID");
  record.jobId = job.job_id;
  await checkpoint();
}
