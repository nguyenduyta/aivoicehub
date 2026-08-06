/**
 * Behavioural test for the transcript record (`TranscriptUI.fullSegments`).
 *
 * Runs the real TranscriptUI against a minimal DOM stub and asserts that the *display* buffer is
 * trimmed while the *record* keeps every segment — which is what save / summary / MTG export read.
 * Guards the regression where a saved transcript held only the tail of the display buffer
 * (~2.4k of a 21k-character meeting).
 *
 * Run with:  node scripts/test-transcript-record.mjs
 */
import assert from 'node:assert/strict';

// ─── minimal DOM stub ──────────────────────────────────────
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeEl(className = '') {
    const el = {
        className,
        _text: null,
        _html: '',
        style: { setProperty() {}, cssText: '' },
        children: [],
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        parentElement: null,
        appendChild(c) {
            this.children.push(c);
            c.parentElement = this;
            return c;
        },
        remove() {},
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        setAttribute() {},
    };
    Object.defineProperty(el, 'textContent', {
        get() {
            return this._text ?? '';
        },
        set(v) {
            this._text = v;
            this._html = esc(v);
        },
    });
    Object.defineProperty(el, 'innerHTML', {
        get() {
            return this._html;
        },
        set(v) {
            this._html = v;
            this.children = [];
        },
    });
    return el;
}

global.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
};

const { TranscriptUI } = await import(new URL('../src/js/ui.js', import.meta.url).href);

// ─── the scenario: a long meeting ──────────────────────────
const container = makeEl('transcript-content');
const ui = new TranscriptUI(container);
// The user's real setting: max_lines 15 → maxChars 2400.
ui.configure({ maxLines: 15, showOriginal: true, fontSize: 27 });

const TURNS = 400;
for (let i = 1; i <= TURNS; i++) {
    ui.addOriginal(`原文 ${i} ${'x'.repeat(40)}`, (i % 3) + 1);
    ui.addTranslation(`bản dịch ${i} ${'y'.repeat(40)}`);
}

// 1) Display buffer IS trimmed (that is its job).
assert.ok(
    ui.segments.length < TURNS,
    `display buffer should be trimmed, got ${ui.segments.length}`,
);

// 2) The record keeps everything.
assert.equal(ui.fullSegments.length, TURNS, 'fullSegments must keep every turn');

// 3) Pairing survived trimming — every turn matched its own translation.
for (let i = 0; i < TURNS; i++) {
    const seg = ui.fullSegments[i];
    assert.equal(seg.status, 'translated', `turn ${i + 1} not translated`);
    assert.ok(
        seg.original.startsWith(`原文 ${i + 1} `),
        `turn ${i + 1} original mismatch: ${seg.original}`,
    );
    assert.ok(
        seg.translation.startsWith(`bản dịch ${i + 1} `),
        `turn ${i + 1} translation mismatch: ${seg.translation}`,
    );
}

// 4) What gets persisted / summarized contains the whole meeting.
const md = ui.getFormattedContent({ model: 'Soniox', sourceLang: 'ja', targetLang: 'vi' });
assert.ok(md.includes('bản dịch 1 '), 'saved markdown lost the first turn');
assert.ok(md.includes(`bản dịch ${TURNS} `), 'saved markdown lost the last turn');
assert.ok(md.includes(`segments: ${TURNS}`), 'front matter segment count wrong');

const summaryText = ui.getSummaryText();
assert.ok(summaryText.includes('bản dịch 1 '), 'summary text lost the first turn');
assert.ok(summaryText.includes(`bản dịch ${TURNS} `), 'summary text lost the last turn');
assert.ok(summaryText.includes('Speaker '), 'summary text should carry speaker labels');

const plain = ui.getPlainText();
assert.ok(plain.includes('bản dịch 1 '), 'copy text lost the first turn');

const stats = ui.getStats();
assert.equal(stats.segments, TURNS);
assert.equal(stats.translated, TURNS);
assert.equal(stats.speakers, 3);

// Compare against the old behaviour to show the size of the bug that was fixed.
const displayOnlyChars = ui.segments.reduce(
    (n, s) => n + (s.translation || s.original || '').length,
    0,
);
console.log(
    `display buffer: ${ui.segments.length} segs / ~${displayOnlyChars} chars   ` +
        `record: ${ui.fullSegments.length} segs / ${stats.chars} chars`,
);

// ─── late translation for an already-trimmed original ──────
{
    const ui2 = new TranscriptUI(makeEl());
    ui2.configure({ maxLines: 2, showOriginal: true });
    ui2.addOriginal('first line ' + 'a'.repeat(200), 1);
    // Translations must be long too: _trimSegments measures the translation when present.
    for (let i = 0; i < 8; i++) {
        ui2.addOriginal('filler ' + i + 'b'.repeat(100), 1);
        ui2.addTranslation('dịch filler ' + i + 'c'.repeat(150));
    }
    // The very first original is long gone from the display buffer…
    assert.ok(!ui2.segments.includes(ui2.fullSegments[0]), 'expected first seg to be trimmed away');
    // …and its translation still landed on it, in order.
    assert.ok(
        ui2.fullSegments[0].translation.startsWith('dịch filler 0'),
        `first seg paired wrongly: ${ui2.fullSegments[0].translation?.slice(0, 30)}`,
    );
    assert.equal(ui2.fullSegments.length, 9, 'record must hold all 9 turns');
}

// ─── stale originals keep their text but stop capturing ────
{
    const ui3 = new TranscriptUI(makeEl());
    ui3.configure({ maxLines: 15 });
    ui3.addOriginal('orphan utterance', 1);
    // Simulate the bind window elapsing.
    ui3.fullSegments[0].createdAt = Date.now() - 60_000;
    ui3.addOriginal('later utterance', 2);
    ui3.addTranslation('dịch của later');

    assert.equal(ui3.fullSegments[0].status, 'untranslated', 'stale original should be sealed');
    assert.equal(ui3.fullSegments[0].original, 'orphan utterance', 'text must be preserved');
    assert.equal(
        ui3.fullSegments[1].translation,
        'dịch của later',
        'translation must bind to the fresh original, not the stale one',
    );
    const md3 = ui3.getFormattedContent({});
    assert.ok(md3.includes('orphan utterance'), 'untranslated line must still be saved');
}

// ─── resume: reloading a note must not truncate on next save ───
{
    const ui4 = new TranscriptUI(makeEl());
    ui4.configure({ maxLines: 2 });
    ui4.loadFromMarkdown(md);
    assert.equal(
        ui4.fullSegments.length,
        TURNS,
        `resume must rehydrate the full record, got ${ui4.fullSegments.length}`,
    );
    const again = ui4.getFormattedContent({});
    assert.ok(again.includes('bản dịch 1 '), 'resave after resume lost the first turn');
    assert.ok(again.includes(`bản dịch ${TURNS} `), 'resave after resume lost the last turn');

    // A restored line must not swallow a new translation.
    ui4.addOriginal('brand new line', 1);
    ui4.addTranslation('dịch mới');
    const fresh = ui4.fullSegments[ui4.fullSegments.length - 1];
    assert.equal(fresh.original, 'brand new line');
    assert.equal(fresh.translation, 'dịch mới');
}

// ─── clear() resets both buffers ───────────────────────────
{
    const ui5 = new TranscriptUI(makeEl());
    ui5.addOriginal('x', 1);
    ui5.addTranslation('y');
    ui5.clear();
    assert.equal(ui5.fullSegments.length, 0);
    assert.equal(ui5.segments.length, 0);
    assert.equal(ui5.hasSegments(), false);
    assert.equal(ui5.getFormattedContent({}), null);
}

console.log('\n✅ all transcript-record assertions passed');
