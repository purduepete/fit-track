import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** One delegated host keeps tooltip triggers, including table cells, in their original DOM. */
export function Tooltip() {
    const id = useId();
    const popup = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState<{ trigger: HTMLElement; text: string } | null>(null);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => clearTimeout(timer);
        const dismiss = () => {
            cancel();
            setActive(null);
        };
        const findTrigger = (target: EventTarget | null) =>
            target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
        const enter = (event: Event) => {
            if (popup.current?.contains(event.target as Node)) {
                cancel();
                return;
            }
            const trigger = findTrigger(event.target);
            if (!trigger?.dataset.tip) return;
            cancel();
            setActive((current) => {
                if (current?.trigger === trigger && current.text === trigger.dataset.tip) return current;
                return { trigger, text: trigger.dataset.tip! };
            });
        };
        const leave = (event: Event) => {
            const related = (event as FocusEvent | PointerEvent).relatedTarget;
            if (
                related instanceof Node &&
                (popup.current?.contains(related) || findTrigger(event.target)?.contains(related))
            )
                return;
            cancel();
            timer = setTimeout(dismiss, 150);
        };
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') dismiss();
        };
        document.addEventListener('pointerover', enter);
        document.addEventListener('pointerout', leave);
        document.addEventListener('focusin', enter);
        document.addEventListener('focusout', leave);
        document.addEventListener('keydown', key, true);
        document.addEventListener('pointerdown', dismiss, true);
        document.addEventListener('click', dismiss, true);
        document.addEventListener('scroll', dismiss, true);
        window.addEventListener('resize', dismiss);
        window.visualViewport?.addEventListener('resize', dismiss);
        window.visualViewport?.addEventListener('scroll', dismiss);
        return () => {
            cancel();
            document.removeEventListener('pointerover', enter);
            document.removeEventListener('pointerout', leave);
            document.removeEventListener('focusin', enter);
            document.removeEventListener('focusout', leave);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('pointerdown', dismiss, true);
            document.removeEventListener('click', dismiss, true);
            document.removeEventListener('scroll', dismiss, true);
            window.removeEventListener('resize', dismiss);
            window.visualViewport?.removeEventListener('resize', dismiss);
            window.visualViewport?.removeEventListener('scroll', dismiss);
        };
    }, []);

    useLayoutEffect(() => {
        if (!active || !popup.current) return;
        const { trigger } = active;
        const tokens = (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        trigger.setAttribute('aria-describedby', [...new Set([...tokens, id])].join(' '));
        // The popover top layer clears clipping and modal dialogs; the dialog portal is the fallback.
        popup.current.setAttribute('popover', 'manual');
        popup.current.showPopover?.();
        const anchor = trigger.getBoundingClientRect();
        const box = popup.current.getBoundingClientRect();
        const viewport = window.visualViewport;
        const x = viewport?.offsetLeft ?? 0;
        const y = viewport?.offsetTop ?? 0;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        const left = Math.max(x + 8, Math.min(anchor.left + (anchor.width - box.width) / 2, x + width - box.width - 8));
        const below = anchor.bottom + 6;
        const top = Math.max(
            y + 8,
            Math.min(
                below + box.height <= y + height - 8 ? below : anchor.top - box.height - 6,
                y + height - box.height - 8
            )
        );
        popup.current.style.left = `${left}px`;
        popup.current.style.top = `${top}px`;
        popup.current.style.visibility = 'visible';
        return () => {
            const remaining = (trigger.getAttribute('aria-describedby') ?? '')
                .split(/\s+/)
                .filter((token) => token && token !== id);
            if (remaining.length) trigger.setAttribute('aria-describedby', remaining.join(' '));
            else trigger.removeAttribute('aria-describedby');
        };
    }, [active, id]);

    if (!active) return null;
    return createPortal(
        <div
            ref={popup}
            id={id}
            role="tooltip"
            className="app-tooltip"
            style={{ left: 0, top: 0, visibility: 'hidden' }}
        >
            {active.text}
        </div>,
        active.trigger.closest('dialog') ?? document.body
    );
}
