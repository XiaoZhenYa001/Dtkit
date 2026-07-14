let initialized = false;

export function initSettingsNavigation() {
    if (initialized) return;
    const navigation = document.querySelector('.settings-side-nav');
    if (!navigation) return;
    initialized = true;

    const links = [...navigation.querySelectorAll('a[href^="#"]')];
    const sections = links
        .map(link => document.querySelector(link.getAttribute('href')))
        .filter(Boolean);
    let navigationLockUntil = 0;

    const activate = sectionId => {
        links.forEach(link => {
            const active = link.getAttribute('href') === `#${sectionId}`;
            link.classList.toggle('settings-side-nav__item--active', active);
            if (active) link.setAttribute('aria-current', 'true');
            else link.removeAttribute('aria-current');
        });
    };

    links.forEach(link => {
        link.addEventListener('click', event => {
            const section = document.querySelector(link.getAttribute('href'));
            if (!section) return;
            event.preventDefault();
            navigationLockUntil = performance.now() + 1200;
            activate(section.id);
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.replaceState(null, '', `#${section.id}`);
        });
    });

    const observer = new IntersectionObserver(entries => {
        if (performance.now() < navigationLockUntil) return;
        const visible = entries
            .filter(entry => entry.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) activate(visible.target.id);
    }, { root: document.querySelector('.content-area'), rootMargin: '-10% 0px -65%', threshold: [0, 0.25, 0.5] });

    sections.forEach(section => observer.observe(section));
    activate(sections[0]?.id);
}
