import { Children, isValidElement, useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";

type Props = ComponentProps<"select">;

// Keep the real select for form semantics and desktop interaction. On mobile,
// present its options in a dialog instead of the OS menu, whose sizing ignores CSS.
export function MobileSelect(props: Props) {
  const select = useRef<HTMLSelectElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const rtl = document.documentElement.dir === "rtl";
  const options: { value: string; label: string; disabled: boolean }[] = [];
  Children.forEach(props.children, child => {
    if (isValidElement<ComponentProps<"option">>(child) && child.type === "option") {
      const label = Children.toArray(child.props.children).join("");
      options.push({ value: String(child.props.value ?? label), label, disabled: Boolean(child.props.disabled) });
    }
  });
  const close = () => { setOpen(false); select.current?.focus(); };
  const show = () => {
    const label = select.current?.labels?.[0];
    setTitle(props["aria-label"] || (label ? Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim() : "") || (rtl ? "בחירת אפשרות" : "Choose an option"));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const selected = dialog.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    selected?.focus();
    return () => { dialog.current?.close(); };
  }, [open]);
  const mobile = () => window.matchMedia("(max-width: 880px)").matches;
  return <>
    <select {...props} ref={select}
      onPointerDown={event => {
        props.onPointerDown?.(event);
        // Suppress the native menu, but wait for the completed click to open.
        // Opening on pointerdown lets the same tap land on the new dialog.
        if (!event.defaultPrevented && !props.disabled && mobile()) event.preventDefault();
      }}
      onClick={event => {
        props.onClick?.(event);
        if (!event.defaultPrevented && !props.disabled && mobile()) { event.preventDefault(); show(); }
      }}
      onKeyDown={event => {
        props.onKeyDown?.(event);
        if (!event.defaultPrevented && mobile() && (event.key === "Enter" || event.key === " " || (event.altKey && event.key === "ArrowDown"))) { event.preventDefault(); show(); }
      }}
    />
    {open && createPortal(<dialog ref={dialog} className="mobile-select-dialog" aria-label={title} dir={rtl ? "rtl" : "ltr"} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="mobile-select-content">
        <header><h2>{title}</h2><button type="button" className="mobile-select-close" aria-label={rtl ? "סגירה" : "Close"} onClick={close}>×</button></header>
        <div className="mobile-select-options">
          {options.map(option => <button type="button" key={option.value} disabled={option.disabled} aria-pressed={String(props.value ?? select.current?.value) === option.value} onClick={() => {
            if (select.current) {
              select.current.value = option.value;
              select.current.dispatchEvent(new Event("change", { bubbles: true }));
            }
            close();
          }}><span>{option.label}</span>{String(props.value ?? select.current?.value) === option.value && <span aria-hidden="true">✓</span>}</button>)}
        </div>
      </div>
    </dialog>, document.body)}
  </>;
}
