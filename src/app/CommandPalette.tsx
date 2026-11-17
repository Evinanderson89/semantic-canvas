import React, { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCategory = "Actions" | "Semantic Metrics" | "Themes" | "Navigate";

export type PaletteItem = {
  id: string;
  label: string;
  subtitle?: string;
  category: "Actions" | "Semantic Metrics" | "Themes" | "Navigate";
  keywords?: string[];
  shortcut?: string;
  onSelect: () => void;
};

export type PaletteGroup = {
  category: PaletteCategory;
  items: PaletteItem[];
};

export const PALETTE_CATEGORY_ORDER: readonly PaletteCategory[] = [
  "Actions",
  "Themes",
  "Navigate",
  "Semantic Metrics",
];

function normalizeSeparators(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-./:·()[\],]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWordBoundary(text: string, needleLower: string, needleNorm: string): boolean {
  const norm = normalizeSeparators(text);
  if (!norm) return false;
  const words = norm.split(" ");
  if (words.some((w, idx) => idx > 0 && w.startsWith(needleLower))) return true;
  if (needleNorm && (" " + norm).includes(" " + needleNorm) && !norm.startsWith(needleNorm)) {
    return true;
  }
  // CamelCase or punctuation boundary inside raw text (after index 0)
  const lower = text.toLowerCase();
  let pos = lower.indexOf(needleLower, 1);
  while (pos > 0) {
    const prev = text[pos - 1];
    if (/[\s_\-./:·()[\]]/.test(prev) || (prev >= "a" && prev <= "z" && text[pos] >= "A" && text[pos] <= "Z")) {
      return true;
    }
    pos = lower.indexOf(needleLower, pos + 1);
  }
  return false;
}

function scorePhraseAgainstItem(item: PaletteItem, qLower: string, qNorm: string): number {
  if (!qLower) return 1;

  const labelLower = item.label.toLowerCase().trim();
  const labelNorm = normalizeSeparators(item.label);

  let labelScore = 0;
  if (labelLower === qLower || (qNorm.length > 0 && labelNorm === qNorm)) {
    labelScore = 1000 - Math.min(35, labelLower.length * 0.2);
  } else if (labelLower.startsWith(qLower) || (qNorm.length > 0 && labelNorm.startsWith(qNorm))) {
    labelScore = 850 - Math.min(35, Math.max(0, labelLower.length - qLower.length) * 0.25);
  } else if (hasWordBoundary(item.label, qLower, qNorm)) {
    labelScore = 700 - Math.min(35, labelLower.length * 0.2);
  } else if (labelLower.includes(qLower) || (qNorm.length > 0 && labelNorm.includes(qNorm))) {
    const idx = labelLower.indexOf(qLower);
    labelScore = 550 - Math.min(35, Math.max(0, idx) * 0.4);
  }

  let keywordScore = 0;
  let exactKeywordBonus = 0;
  for (const rawKw of item.keywords ?? []) {
    if (!rawKw) continue;
    const kwLower = rawKw.toLowerCase().trim();
    if (!kwLower) continue;
    const kwNorm = normalizeSeparators(rawKw);
    let current = 0;
    if (kwLower === qLower || (qNorm.length > 0 && kwNorm === qNorm)) {
      current = 460;
      exactKeywordBonus = 5;
    } else if (kwLower.startsWith(qLower) || (qNorm.length > 0 && kwNorm.startsWith(qNorm))) {
      current = 410 - Math.min(20, Math.max(0, kwLower.length - qLower.length) * 0.25);
    } else if (hasWordBoundary(rawKw, qLower, qNorm)) {
      current = 360;
    } else if (kwLower.includes(qLower) || (qNorm.length > 0 && kwNorm.includes(qNorm))) {
      current = 310;
    }
    if (current > keywordScore) keywordScore = current;
  }

  let metaScore = 0;
  for (const meta of [item.subtitle ?? "", item.category]) {
    if (!meta) continue;
    const mLower = meta.toLowerCase().trim();
    const mNorm = normalizeSeparators(meta);
    let current = 0;
    if (
      mLower === qLower ||
      mLower.startsWith(qLower) ||
      (qNorm.length > 0 && (mNorm === qNorm || mNorm.startsWith(qNorm))) ||
      hasWordBoundary(meta, qLower, qNorm)
    ) {
      current = 230;
    } else if (mLower.includes(qLower) || (qNorm.length > 0 && mNorm.includes(qNorm))) {
      current = 170;
    }
    if (current > metaScore) metaScore = current;
  }

  const best = Math.max(labelScore, keywordScore, metaScore);
  if (best === 0) return 0;
  return labelScore > 0 ? best + exactKeywordBonus : best;
}

/**
 * Score a single palette item against a user query.
 * Tier hierarchy:
 *   exact label (1000) > exact prefix (850) > word boundary (700) >
 *   label substring (550) > keyword/synonym match (310–460) >
 *   subtitle/category match (170–230) > multi-token match.
 */
export function scorePaletteItem(item: PaletteItem, query: string): number {
  const qLower = query.trim().toLowerCase();
  if (!qLower) return 1;
  const qNorm = normalizeSeparators(qLower);

  const direct = scorePhraseAgainstItem(item, qLower, qNorm);
  if (direct > 0) return direct;

  const tokens = qNorm.split(" ").filter(Boolean);
  if (tokens.length <= 1) return 0;

  let sum = 0;
  let allInLabel = true;
  const labelNorm = normalizeSeparators(item.label);
  const labelLower = item.label.toLowerCase();
  for (const token of tokens) {
    const tokenScore = scorePhraseAgainstItem(item, token, token);
    if (tokenScore <= 0) return 0;
    sum += tokenScore;
    if (!labelLower.includes(token) && !labelNorm.includes(token)) {
      allInLabel = false;
    }
  }
  const avg = sum / tokens.length;
  return allInLabel ? Math.min(510, 260 + avg * 0.28) : Math.min(295, 120 + avg * 0.22);
}

/**
 * Rank and filter command palette items across `label`, `subtitle`, `category`, and `keywords`.
 */
export function rankPaletteItems(items: PaletteItem[], query: string): PaletteItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];

  const scored: { item: PaletteItem; score: number; index: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const score = scorePaletteItem(item, trimmed);
    if (score > 0) {
      scored.push({ item, score, index: i });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map((entry) => entry.item);
}

/**
 * Group ranked items cleanly by category.
 * - With an empty query: canonical order (`Actions`, `Themes`, `Navigate`, `Semantic Metrics`).
 * - With an active search query: categories are ordered by their highest-ranked hit so the #1
 *   overall match is always at index 0 for immediate `Enter` activation.
 */
export function groupPaletteItems(rankedItems: PaletteItem[], query: string): PaletteGroup[] {
  const byCategory = new Map<PaletteCategory, PaletteItem[]>();
  for (const item of rankedItems) {
    const bucket = byCategory.get(item.category);
    if (bucket) bucket.push(item);
    else byCategory.set(item.category, [item]);
  }

  const order: readonly PaletteCategory[] = query.trim()
    ? Array.from(byCategory.keys())
    : PALETTE_CATEGORY_ORDER;

  const groups: PaletteGroup[] = [];
  for (const category of order) {
    const list = byCategory.get(category);
    if (list && list.length > 0) {
      groups.push({ category, items: list });
    }
  }
  return groups;
}

/**
 * Surface the matched keyword/synonym when the user's query matched via `keywords`
 * rather than the primary `label`, making synonym-aware discovery transparent.
 */
export function findMatchedKeyword(item: PaletteItem, query: string): string | null {
  const qLower = query.trim().toLowerCase();
  if (!qLower || !item.keywords?.length) return null;
  const qNorm = normalizeSeparators(qLower);
  const labelLower = item.label.toLowerCase();
  const labelNorm = normalizeSeparators(item.label);
  if (labelLower.includes(qLower) || (qNorm && labelNorm.includes(qNorm))) {
    return null;
  }

  let bestKw: string | null = null;
  let bestTier = 0;
  for (const kw of item.keywords) {
    if (!kw) continue;
    const kwLower = kw.toLowerCase().trim();
    const kwNorm = normalizeSeparators(kw);
    let tier = 0;
    if (kwLower === qLower || (qNorm && kwNorm === qNorm)) tier = 4;
    else if (kwLower.startsWith(qLower) || (qNorm && kwNorm.startsWith(qNorm))) tier = 3;
    else if (hasWordBoundary(kw, qLower, qNorm)) tier = 2;
    else if (kwLower.includes(qLower) || (qNorm && kwNorm.includes(qNorm))) tier = 1;
    if (tier > bestTier) {
      bestTier = tier;
      bestKw = kw;
    }
  }
  return bestKw;
}

export function stepPaletteIndex(current: number, delta: 1 | -1, total: number): number {
  if (total <= 0) return 0;
  const safe = current >= 0 && current < total ? current : 0;
  return (safe + delta + total) % total;
}

function CategoryGlyph({ category }: { category: PaletteCategory }) {
  if (category === "Semantic Metrics") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M2.5 12.5V8.5M6.2 12.5V5.5M9.8 12.5V7M13.5 12.5V3.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (category === "Themes") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="8" cy="8" r="5.25" />
        <path d="M8 2.75v10.5" />
      </svg>
    );
  }
  if (category === "Navigate") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8.8 2.2 4 8.6h3.7L7.2 13.8 12 7.4H8.3z" strokeLinejoin="round" />
    </svg>
  );
}

export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const keyboardMovedRef = useRef(false);

  const ranked = useMemo(() => rankPaletteItems(items, query), [items, query]);
  const groups = useMemo(() => groupPaletteItems(ranked, query), [ranked, query]);
  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const safeIndex = flatItems.length === 0 ? 0 : Math.min(activeIndex, flatItems.length - 1);
  const activeItem = flatItems[safeIndex] ?? null;

  useEffect(() => {
    if (!open) return;
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !keyboardMovedRef.current) return;
    keyboardMovedRef.current = false;
    const opt = listRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${safeIndex}`);
    opt?.scrollIntoView?.({ block: "nearest" });
  }, [open, safeIndex]);

  if (!open) return null;

  const dismissOnly = () => {
    const origin = returnFocusRef.current;
    returnFocusRef.current = null;
    onClose();
    if (origin && origin.isConnected) {
      requestAnimationFrame(() => origin.focus({ preventScroll: true }));
    }
  };

  const executeItem = (item: PaletteItem) => {
    returnFocusRef.current = null;
    onClose();
    item.onSelect();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatItems.length > 0) {
        keyboardMovedRef.current = true;
        setActiveIndex(stepPaletteIndex(safeIndex, 1, flatItems.length));
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatItems.length > 0) {
        keyboardMovedRef.current = true;
        setActiveIndex(stepPaletteIndex(safeIndex, -1, flatItems.length));
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeItem) {
        executeItem(activeItem);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissOnly();
    }
  };

  let runningIndex = 0;

  return (
    <div
      className="cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismissOnly();
      }}
    >
      <div
        className="cmdk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-input-row">
          <svg
            className="cmdk-search-icon"
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <circle cx="8.75" cy="8.75" r="5.5" />
            <path d="m13 13 4 4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="cmdk-input"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeItem ? `cmdk-opt-${safeIndex}` : undefined}
            aria-label="Search commands and governed metrics"
            placeholder="Jump to a governed metric, run an action, or switch theme…"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
          />
          {query && (
            <button
              type="button"
              className="cmdk-clear"
              aria-label="Clear search query"
              onClick={() => {
                setQuery("");
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              Clear
            </button>
          )}
          <kbd className="cmdk-shortcut" aria-hidden="true">esc</kbd>
        </div>

        <div
          ref={listRef}
          id="cmdk-listbox"
          className="cmdk-list"
          role="listbox"
          aria-label="Command palette results"
        >
          {groups.length === 0 ? (
            <div className="cmdk-empty" role="status">
              <strong>No governed metrics, actions, or themes match “{query.trim()}”.</strong>
              <p>
                Try a business synonym (such as <code>ARR</code>, <code>topline</code>, or <code>churn</code>),
                a warehouse table name, or type <code>Coach</code> to propose a new governed metric.
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div
                key={group.category}
                className="cmdk-group"
                role="group"
                aria-label={group.category}
              >
                <div className="cmdk-group-label" aria-hidden="true">
                  <span>{group.category}</span>
                  <span className="cmdk-group-count">{group.items.length}</span>
                </div>
                {group.items.map((item) => {
                  const itemIndex = runningIndex++;
                  const isActive = itemIndex === safeIndex;
                  const matchedSynonym = findMatchedKeyword(item, query);
                  return (
                    <button
                      key={item.id}
                      id={`cmdk-opt-${itemIndex}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={"cmdk-item" + (isActive ? " active" : "")}
                      onMouseEnter={() => setActiveIndex(itemIndex)}
                      onClick={() => executeItem(item)}
                    >
                      <span className="cmdk-item-icon">
                        <CategoryGlyph category={item.category} />
                      </span>
                      <span className="cmdk-item-main">
                        <span className="cmdk-item-title-row">
                          <span className="cmdk-item-label">{item.label}</span>
                          {matchedSynonym && (
                            <span className="cmdk-synonym-pill" title={`Matched synonym or identifier: ${matchedSynonym}`}>
                              ≈ {matchedSynonym}
                            </span>
                          )}
                        </span>
                        {item.subtitle && <span className="cmdk-item-sub">{item.subtitle}</span>}
                      </span>
                      {item.shortcut && <kbd className="cmdk-shortcut">{item.shortcut}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Launch</span>
          <span><kbd>esc</kbd> Close</span>
          <span className="spacer" />
          <span className="cmdk-footer-hint">Synonym-aware governed launcher</span>
        </div>
      </div>
    </div>
  );
}
