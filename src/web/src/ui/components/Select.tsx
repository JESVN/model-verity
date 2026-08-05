import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  keywords?: string;
  badge?: string;
  badgeTone?: "builtin" | "local" | "neutral";
  description?: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  "aria-label"?: string;
}

interface MenuPosition extends CSSProperties {
  "--select-menu-width"?: string;
  "--select-menu-left"?: string;
  "--select-menu-top"?: string;
  "--select-menu-max-height"?: string;
}

export function Select({
  id,
  value,
  options,
  onChange,
  placeholder = "请选择",
  disabled = false,
  searchable = false,
  searchPlaceholder = "搜索选项",
  emptyMessage = "没有匹配项",
  "aria-label": ariaLabel,
}: SelectProps) {
  const generatedId = useId().replace(/:/g, "");
  const triggerId = id ?? `select-${generatedId}`;
  const listboxId = `${triggerId}-listbox`;
  const searchId = `${triggerId}-search`;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const [position, setPosition] = useState<MenuPosition>({});

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase("und");
  const filteredIndexes = useMemo(
    () => options.flatMap((option, index) => {
      if (!normalizedQuery) return [index];
      const haystack = `${option.label} ${option.description ?? ""} ${option.keywords ?? ""} ${option.badge ?? ""}`.toLocaleLowerCase("und");
      return haystack.includes(normalizedQuery) ? [index] : [];
    }),
    [normalizedQuery, options],
  );
  const enabledIndexes = useMemo(
    () => filteredIndexes.filter((index) => !options[index]?.disabled),
    [filteredIndexes, options],
  );

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 7;
      const viewportGap = 12;
      const availableBelow = window.innerHeight - rect.bottom - viewportGap - gap;
      const availableAbove = rect.top - viewportGap - gap;
      const maxHeight = Math.min(searchable ? 320 : 248, Math.max(160, Math.max(availableBelow, availableAbove)));
      const openAbove = availableBelow < 200 && availableAbove > availableBelow;
      const measuredHeight = Math.min(maxHeight, menuRef.current?.scrollHeight ?? maxHeight);
      const top = openAbove ? Math.max(viewportGap, rect.top - measuredHeight - gap) : rect.bottom + gap;
      const width = triggerId === "reference-page-size" ? rect.width : Math.max(180, rect.width);
      setPosition({
        "--select-menu-width": `${width}px`,
        "--select-menu-left": `${Math.max(viewportGap, Math.min(rect.left, window.innerWidth - width - viewportGap))}px`,
        "--select-menu-top": `${top}px`,
        "--select-menu-max-height": `${maxHeight}px`,
      });
    };
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!rootRef.current?.contains(node) && !menuRef.current?.contains(node)) setOpen(false);
    };
    updatePosition();
    const lockBody = window.matchMedia("(max-width: 600px)").matches;
    const previousOverflow = document.body.style.overflow;
    if (lockBody) document.body.style.overflow = "hidden";
    document.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      if (lockBody) document.body.style.overflow = previousOverflow;
    };
  }, [open, searchable]);

  useEffect(() => {
    if (!open || highlighted < 0) return;
    optionRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const preferred = filteredIndexes.includes(selectedIndex) && !options[selectedIndex]?.disabled
      ? selectedIndex
      : enabledIndexes[0] ?? -1;
    setHighlighted(preferred);
  }, [enabledIndexes, filteredIndexes, open, options, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current != null) window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  const openMenu = (preferredIndex = selectedIndex) => {
    if (disabled || options.length === 0) return;
    setQuery("");
    setHighlighted(!options[preferredIndex]?.disabled && preferredIndex >= 0 ? preferredIndex : options.findIndex((option) => !option.disabled));
    setOpen(true);
  };

  const moveHighlight = (direction: 1 | -1) => {
    if (!open) {
      openMenu(direction === 1 ? selectedIndex : options.length - 1);
      return;
    }
    if (!enabledIndexes.length) return;
    const current = enabledIndexes.indexOf(highlighted);
    const next = current < 0
      ? direction === 1 ? 0 : enabledIndexes.length - 1
      : (current + direction + enabledIndexes.length) % enabledIndexes.length;
    setHighlighted(enabledIndexes[next]);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange?.(option.value);
    setHighlighted(index);
    setOpen(false);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(".select-trigger")?.focus());
  };

  const typeahead = (character: string) => {
    typeaheadRef.current += character.toLocaleLowerCase("und");
    if (typeaheadTimerRef.current != null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = ""; }, 700);
    const needle = typeaheadRef.current;
    const start = Math.max(0, enabledIndexes.indexOf(highlighted) + 1);
    const ordered = [...enabledIndexes.slice(start), ...enabledIndexes.slice(0, start)];
    const match = ordered.find((index) => options[index]?.label.toLocaleLowerCase("und").includes(needle));
    if (match != null) {
      if (!open) setOpen(true);
      setHighlighted(match);
    }
  };

  const handleNavigationKey = (event: KeyboardEvent<HTMLElement>) => {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); moveHighlight(1); return true;
      case "ArrowUp": event.preventDefault(); moveHighlight(-1); return true;
      case "Home": if (open && enabledIndexes.length) { event.preventDefault(); setHighlighted(enabledIndexes[0]); return true; } break;
      case "End": if (open && enabledIndexes.length) { event.preventDefault(); setHighlighted(enabledIndexes.at(-1) ?? -1); return true; } break;
      case "Enter": if (open && highlighted >= 0) { event.preventDefault(); choose(highlighted); return true; } break;
      case "Escape": if (open) { event.preventDefault(); setOpen(false); return true; } break;
      case "Tab": setOpen(false); break;
    }
    return false;
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); moveHighlight(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveHighlight(-1); }
    else if (event.key === "Enter" && highlighted >= 0) { event.preventDefault(); choose(highlighted); }
    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    else if (event.key === "Tab") setOpen(false);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (handleNavigationKey(event)) return;
    if (event.key === " ") {
      event.preventDefault();
      if (open && highlighted >= 0) choose(highlighted); else openMenu();
      return;
    }
    if (event.key === "Enter" && !open) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (searchable) {
        setQuery(event.key);
        setOpen(true);
      } else typeahead(event.key);
    }
  };

  const menu = open ? (
    <div className="select-layer">
      <button className="select-scrim" type="button" tabIndex={-1} aria-label="关闭选项" onClick={() => setOpen(false)} />
      <div ref={menuRef} className={`select-menu${searchable ? " is-searchable" : ""}${triggerId === "reference-page-size" ? " is-page-size" : ""}`} style={position}>
        <div className="select-mobile-handle" aria-hidden="true" />
        {searchable ? (
          <div className="select-search-wrap">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
            <input
              id={searchId}
              ref={searchRef}
              type="search"
              role="searchbox"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
        ) : null}
        <div
          id={listboxId}
          className="select-options"
          role="listbox"
          aria-label={ariaLabel ?? "选项"}
          aria-activedescendant={highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined}
        >
          {filteredIndexes.map((index) => {
            const option = options[index];
            const isSelected = index === selectedIndex;
            const isHighlighted = index === highlighted;
            return (
              <div
                id={`${listboxId}-option-${index}`}
                key={option.value}
                ref={(node) => { optionRefs.current[index] = node; }}
                className={`select-option${isSelected ? " is-selected" : ""}${isHighlighted ? " is-highlighted" : ""}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onPointerMove={() => !option.disabled && setHighlighted(index)}
                onClick={() => choose(index)}
              >
                <span className="select-option-copy"><span className="select-option-label">{option.label}</span>{option.description ? <span className="select-option-description">{option.description}</span> : null}</span>
                {option.badge ? <span className={`select-option-badge tone-${option.badgeTone ?? "neutral"}`}>{option.badge}</span> : null}
                {isSelected ? (
                  <svg className="select-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.25 2.8 2.8 6.2-6.1" /></svg>
                ) : <span className="select-check-spacer" aria-hidden="true" />}
              </div>
            );
          })}
          {!filteredIndexes.length ? <div className="select-empty" role="status">{emptyMessage}</div> : null}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={`select${open ? " is-open" : ""}`} ref={rootRef}>
      <button
        id={triggerId}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={selected ? "select-value" : "select-placeholder"}>{selected?.label ?? placeholder}</span>
        {selected?.badge ? <span className={`select-trigger-badge tone-${selected.badgeTone ?? "neutral"}`}>{selected.badge}</span> : null}
        <svg className="select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {menu && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </div>
  );
}
