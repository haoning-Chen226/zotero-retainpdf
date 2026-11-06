"use strict";

const BRIDGE_STATE_FILENAME = "retainpdf-bridge-state.json";
const BRIDGE_SCAN_INTERVAL_MS = 30_000;
const BRIDGE_SETTLE_MS = 5_000;

var retainBridgeWatcher;

async function startup() {
  retainBridgeWatcher = new RetainBridgeWatcher();
  await retainBridgeWatcher.start();
}

async function shutdown(_data, reason) {
  const watcher = retainBridgeWatcher;
  retainBridgeWatcher = undefined;
  const pending = watcher?.stop();
  if (reason !== APP_SHUTDOWN) {
    await pending;
  }
}

function bridgeSqlTime(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 19).replace("T", " ");
}

function bridgeItemKey(libraryID, itemKey) {
  return `${libraryID}:${itemKey}`;
}

function bridgeIsDerivative(attachment) {
  const filename = attachment.attachmentFilename || "";
  return /(?:^|[._ -])(?:mono|dual|pdf2zh|translated|bilingual|zh|zh-cn)\.pdf$/iu.test(filename)
    || /(?:译文|纯译|双语(?:对照)?)[）)\]]?\.pdf$/u.test(filename);
}

class RetainBridgeWatcher {
  constructor() {
    this.libraryID = Zotero.Libraries.userLibraryID;
    this.statePath = PathUtils.join(Zotero.DataDirectory.dir, BRIDGE_STATE_FILENAME);
  }

  async start() {
    if (await IOUtils.exists(this.statePath)) {
      this.state = JSON.parse(await IOUtils.readUTF8(this.statePath));
      if (this.state?.version !== 1 || typeof this.state.since !== "string"
          || !Array.isArray(this.state.baseline)
          || !this.state.records || typeof this.state.records !== "object") {
        throw new Error("RetainPDF bridge state has an unsupported format");
      }
    } else {
      const since = bridgeSqlTime(Date.now());
      const keys = await Zotero.DB.columnQueryAsync(
        "SELECT key FROM items WHERE libraryID=? AND dateAdded>=?",
        [this.libraryID, since]
      );
      this.state = {version: 1, since, baseline: keys, records: {}};
      await this.save();
    }
    this.baseline = new Set(this.state.baseline);
    this.active = true;
    this.observer = Zotero.Notifier.registerObserver({
      notify: (event, type) => {
        if (type === "collection-item" || event === "add" || event === "modify") {
          this.schedule();
        }
      }
    }, ["item", "collection-item"], "retainpdf-bridge");
    this.interval = setInterval(() => this.scan(), BRIDGE_SCAN_INTERVAL_MS);
    this.schedule();
    Zotero.debug("RetainPDF bridge started for My Library");
  }

  stop() {
    this.active = false;
    if (this.observer) {
      Zotero.Notifier.unregisterObserver(this.observer);
    }
    clearInterval(this.interval);
    clearTimeout(this.timer);
    return this.running;
  }

  schedule() {
    if (!this.active || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, BRIDGE_SETTLE_MS);
  }

  scan() {
    if (this.active && !this.running) {
      this.running = this.process()
        .catch(error => Zotero.logError(error))
        .finally(() => { this.running = undefined; });
    }
  }

  async save() {
    await IOUtils.writeUTF8(this.statePath, JSON.stringify(this.state), {
      tmpPath: `${this.statePath}.tmp`,
      flush: true
    });
  }

  async candidates() {
    const latest = bridgeSqlTime(Date.now() - BRIDGE_SETTLE_MS);
    return Zotero.DB.queryAsync(
      `SELECT a.itemID AS attachmentID, a.key AS attachmentKey,
              p.itemID AS parentID, p.key AS parentKey
       FROM itemAttachments AS file
       JOIN items AS a ON a.itemID=file.itemID
       LEFT JOIN items AS p ON p.itemID=file.parentItemID
       WHERE a.libraryID=? AND file.contentType='application/pdf'
         AND file.linkMode IN (?, ?, ?)
         AND a.dateAdded BETWEEN ? AND ?
         AND (p.itemID IS NULL OR p.dateAdded BETWEEN ? AND ?)
         AND NOT EXISTS (
           SELECT 1 FROM deletedItems AS trash
           WHERE trash.itemID IN (a.itemID, p.itemID)
         )
       ORDER BY a.itemID`,
      [
        this.libraryID,
        Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
        Zotero.Attachments.LINK_MODE_IMPORTED_URL,
        Zotero.Attachments.LINK_MODE_LINKED_FILE,
        this.state.since, latest,
        this.state.since, latest
      ]
    );
  }

  async process() {
    const records = this.state.records;
    const rows = await this.candidates();
    if (!rows.length && !Object.values(records).some(record => record.queueStatus === "pending")) {
      return;
    }
    await Zotero.Libraries.userLibrary.waitForDataLoad("item");
    const paperKeys = new Set(Object.values(records).map(record => record.paperKey));
    const papers = new Map();
    let changed = false;
    for (const row of rows) {
      if (this.baseline.has(row.attachmentKey) || this.baseline.has(row.parentKey)) {
        continue;
      }
      const attachmentKey = bridgeItemKey(this.libraryID, row.attachmentKey);
      const paperKey = bridgeItemKey(this.libraryID, row.parentKey || row.attachmentKey);
      const record = records[attachmentKey];
      if (record) {
        // Zotero may recognize a standalone PDF and move it under a new paper.
        // Track the new parent so its other attachments do not start a second job.
        if (row.parentKey && record.paperKey !== paperKey) {
          record.paperKey = paperKey;
          paperKeys.add(paperKey);
          changed = true;
        }
        continue;
      }
      if (!papers.has(paperKey)) {
        papers.set(paperKey, {parentID: row.parentID, attachmentIDs: new Set()});
      }
      papers.get(paperKey).attachmentIDs.add(row.attachmentID);
    }
    if (changed) {
      await this.save();
    }
    for (const record of Object.values(records)) {
      if (!this.active) {
        return;
      }
      if (record.queueStatus === "pending" && record.nextAttempt <= Date.now()) {
        await this.resume(record);
      }
    }
    for (const [paperKey, paper] of papers) {
      if (!this.active) {
        return;
      }
      if (paperKeys.has(paperKey)) {
        continue;
      }
      const parent = paper.parentID && await Zotero.Items.getAsync(paper.parentID);
      if (paper.parentID && (!parent?.isRegularItem() || parent.deleted)) {
        continue;
      }
      const attachments = parent
        ? await parent.getBestAttachments()
        : await Zotero.Items.getAsync([...paper.attachmentIDs]);
      const attachment = attachments.find(item => paper.attachmentIDs.has(item.id)
        && item.isPDFAttachment() && !item.deleted && !bridgeIsDerivative(item));
      if (!attachment) {
        continue;
      }
      const path = await attachment.getFilePathAsync();
      if (!path || !this.active) {
        continue;
      }
      const key = bridgeItemKey(this.libraryID, attachment.key);
      const record = {
        key, paperKey, attachmentKey: attachment.key,
        queueStatus: "pending", attempts: 0, nextAttempt: 0
      };
      records[key] = record;
      await this.save();
      await this.submit(record, attachment, parent, path);
    }
  }

  async resume(record) {
    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
      this.libraryID, record.attachmentKey
    );
    const parent = attachment?.parentID && await Zotero.Items.getAsync(attachment.parentID);
    if (!attachment?.isPDFAttachment() || attachment.deleted || parent?.deleted) {
      record.queueStatus = "skipped";
      await this.save();
      return;
    }
    const path = await attachment.getFilePathAsync();
    if (path) {
      await this.submit(record, attachment, parent, path);
    }
  }

  async groups(item) {
    await item.loadDataType("collections");
    const groups = [];
    for (const id of item.getCollections()) {
      const parts = [];
      let collection = await Zotero.Collections.getAsync(id);
      while (collection && !collection.deleted) {
        parts.unshift(collection.name);
        collection = collection.parentID && await Zotero.Collections.getAsync(collection.parentID);
      }
      if (parts.length > 0) {
        groups.push(parts);
      }
    }
    return groups.length > 0 ? groups : [["未分类"]];
  }

  async submit(record, attachment, parent, path) {
    if (!this.active) {
      return;
    }
    try {
      record.path = path;
      record.filename = PathUtils.filename(path);
      record.title = (parent || attachment).getField("title") || record.filename;
      record.groups = await this.groups(parent || attachment);
      if (!this.active) {
        return;
      }
      // retainSync owns RetainPDF's API checkpoints. Persist each returned
      // identifier before the API adapter performs the next write.
      await retainSync(record, async () => {
        await this.save();
        if (!this.active) {
          throw new Error("RetainPDF bridge paused");
        }
      });
      record.queueStatus = "done";
      Zotero.debug(`RetainPDF bridge submitted ${record.key}`);
    } catch (error) {
      if (error?.permanent === true) {
        record.queueStatus = "failed";
      } else {
        record.attempts += 1;
        const backoff = Math.min(30_000 * 2 ** Math.min(record.attempts - 1, 6), 1_800_000);
        record.nextAttempt = Date.now() + backoff;
      }
      Zotero.debug(`RetainPDF bridge ${record.key}: ${String(error?.message || error).slice(0, 250)}`);
    }
    await this.save();
  }
}
