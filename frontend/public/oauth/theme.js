(() => {
    const key = 'fittrack_theme';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let preference = 'midnight';
    try {
        const saved = localStorage.getItem(key);
        if (['system', 'light', 'midnight'].includes(saved)) preference = saved;
    } catch {
        console.warn('Fit Track: theme storage is unavailable.');
    }
    const apply = () => {
        const light = preference === 'light' || (preference === 'system' && !media.matches);
        document.documentElement.classList.toggle('light', light);
        document.documentElement.classList.toggle('dark', !light);
        document.documentElement.classList.toggle('theme-midnight', !light);
        document.documentElement.style.colorScheme = light ? 'light' : 'dark';
        document.querySelector('meta[name="theme-color"]').content = light ? '#ffffff' : '#020617';
    };
    apply();
    media.addEventListener('change', apply);
    document.addEventListener('DOMContentLoaded', () => {
        const trigger = document.getElementById('theme');
        const menu = document.getElementById('themes');
        const items = [...menu.querySelectorAll('button')];
        const label = () => {
            trigger.textContent = `Theme: ${preference[0].toUpperCase()}${preference.slice(1)}`;
            items.forEach((item) => item.setAttribute('aria-checked', String(item.dataset.theme === preference)));
        };
        const close = (restoreFocus) => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (restoreFocus) trigger.focus();
        };
        const open = (index = items.findIndex((item) => item.dataset.theme === preference)) => {
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            items[index].focus();
        };
        label();
        trigger.addEventListener('click', () => (menu.hidden ? open() : close(false)));
        trigger.addEventListener('keydown', (event) => {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                open(event.key === 'ArrowDown' ? 0 : items.length - 1);
            }
        });
        items.forEach((item) =>
            item.addEventListener('click', () => {
                preference = item.dataset.theme;
                try {
                    localStorage.setItem(key, preference);
                } catch {
                    console.warn('Fit Track: theme preference could not be saved.');
                }
                apply();
                label();
                close(true);
            })
        );
        menu.addEventListener('keydown', (event) => {
            const index = items.indexOf(document.activeElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                close(true);
            } else if (event.key === 'Tab') {
                // Let the browser move focus before hiding the menu.
                setTimeout(() => close(false), 0);
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next =
                    event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next].focus();
            }
        });
        document.addEventListener('pointerdown', (event) => {
            if (!event.target.closest('.theme-control')) close(false);
        });
        document.addEventListener('focusin', (event) => {
            if (!event.target.closest('.theme-control')) close(false);
        });
    });
})();
