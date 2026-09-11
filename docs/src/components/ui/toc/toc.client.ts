/**
 * Scroll-spy + animated rail indicator. Active heading tracked via a single
 * IntersectionObserver; the dash slides by arc-length so it weaves through
 * the rail's curves instead of cutting across.
 */

import { mount } from "@cloudflare/nimbus-docs/client";

const READING_BAND = 0.25;
const BOTTOM_EPSILON = 2;
const REVEAL_PADDING = 12;
const NAV_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

interface RailMeasurement {
  x: number;
  yTop: number;
  yBot: number;
}

interface RailSegment {
  start: number;
  length: number;
}

interface ObservedHeading {
  el: HTMLElement;
  index: number;
}

interface RailResult {
  path: string;
  segments: RailSegment[];
  totalLength: number;
}

interface TocSetup {
  scrollHost: HTMLElement;
  nav: HTMLElement;
  activePath: SVGPathElement;
  links: NodeListOf<HTMLElement>;
  slugs: string[];
  observed: ObservedHeading[];
}

function connectorPath(
  previous: RailMeasurement,
  current: RailMeasurement,
): string {
  if (Math.abs(current.x - previous.x) < 0.5) {
    return `L ${current.x} ${current.yTop} `;
  }

  const midY = (previous.yBot + current.yTop) / 2;
  return `C ${previous.x} ${midY}, ${current.x} ${midY}, ${current.x} ${current.yTop} `;
}

function createRailPath(
  measurements: RailMeasurement[],
  measure: (subPath: string) => number,
): RailResult {
  let path = "";
  const segments: RailSegment[] = [];
  let totalLength = 0;
  let previous: RailMeasurement | undefined;

  for (const current of measurements) {
    const connector = previous
      ? connectorPath(previous, current)
      : `M ${current.x} ${current.yTop} `;
    path += connector;

    if (previous) {
      totalLength += measure(`M ${previous.x} ${previous.yBot} ${connector}`);
    }

    const start = totalLength;
    const segment = `L ${current.x} ${current.yBot} `;
    path += segment;
    totalLength += measure(`M ${current.x} ${current.yTop} ${segment}`);
    segments.push({ start, length: totalLength - start });
    previous = current;
  }

  return { path, segments, totalLength };
}

function initToc(root: HTMLElement): () => void {
  const nav = root.querySelector<HTMLElement>("nav");
  const activePath = root.querySelector<SVGPathElement>(
    "[data-nb-toc-rail-active]",
  );
  const links = root.querySelectorAll<HTMLElement>("[data-nb-toc-link]");
  if (!nav || !activePath || links.length === 0) {
    return () => undefined;
  }

  const slugs = Array.from(links).map((link) => link.dataset.nbSlug!);
  // Observe only resolvable headings, each carrying its original index, so
  // scroll-spy stays aligned with the full-length links/segments even when a
  // heading slugs to "" (e.g. emoji-only `## 🎉`) and has no DOM target.
  const observed = slugs
    .map((slug, index) => ({ el: document.getElementById(slug), index }))
    .filter((heading): heading is ObservedHeading => heading.el !== null);
  if (observed.length === 0) {
    return () => undefined;
  }

  const scrollHost =
    root.closest<HTMLElement>("[data-nb-toc-scroll-host]") ?? root;
  return new TocRuntime({
    scrollHost,
    nav,
    activePath,
    links,
    slugs,
    observed,
  }).mount();
}

class TocRuntime {
  private readonly nav: HTMLElement;
  private readonly activePath: SVGPathElement;
  private readonly links: NodeListOf<HTMLElement>;
  private readonly slugs: string[];
  private readonly observed: ObservedHeading[];
  private readonly indexOfEl: Map<HTMLElement, number>;
  private readonly controller = new AbortController();
  private readonly inBand = new Set<number>();
  private readonly spy: IntersectionObserver;
  private readonly resizeObserver: ResizeObserver;
  private readonly scrollHost: HTMLElement;

  private segments: RailSegment[] = [];
  private totalLength = 0;
  private currentIndex = -1;
  private currentLink: HTMLElement | null = null;
  private hasApplied = false;
  private observedIndex = 0;
  private atBottom = false;
  private pinnedIndex: number | null = null;
  private pinnedEnteredViewport = false;
  private ticking = false;

  constructor(setup: TocSetup) {
    this.nav = setup.nav;
    this.activePath = setup.activePath;
    this.links = setup.links;
    this.slugs = setup.slugs;
    this.observed = setup.observed;
    this.scrollHost = setup.scrollHost;
    this.indexOfEl = new Map(
      setup.observed.map((heading) => [heading.el, heading.index]),
    );
    this.spy = new IntersectionObserver(
      (entries) => this.handleIntersections(entries),
      {
        rootMargin: `0px 0px -${(1 - READING_BAND) * 100}% 0px`,
        threshold: 0,
      },
    );
    this.resizeObserver = new ResizeObserver(() => this.handleLayoutChange());
  }

  mount(): () => void {
    this.bindNavigation();
    this.bindScrolling();
    this.observed.forEach((heading) => this.spy.observe(heading.el));
    this.resizeObserver.observe(this.nav);
    this.refresh();
    return () => this.destroy();
  }

  private destroy(): void {
    this.controller.abort();
    this.resizeObserver.disconnect();
    this.spy.disconnect();
  }

  private bindNavigation(): void {
    this.nav.addEventListener(
      "click",
      (clickEvent) => this.handleNavigationClick(clickEvent),
      { signal: this.controller.signal },
    );
    window.addEventListener(
      "keydown",
      (keyboardEvent) => this.handleNavigationKeydown(keyboardEvent),
      { signal: this.controller.signal },
    );
  }

  private bindScrolling(): void {
    window.addEventListener("wheel", () => this.releasePin(), {
      passive: true,
      signal: this.controller.signal,
    });
    window.addEventListener("touchmove", () => this.releasePin(), {
      passive: true,
      signal: this.controller.signal,
    });
    window.addEventListener("scroll", () => this.handleScroll(), {
      passive: true,
      signal: this.controller.signal,
    });
    window.addEventListener("resize", () => this.handleLayoutChange(), {
      passive: true,
      signal: this.controller.signal,
    });
  }

  private buildRail(): void {
    const navRect = this.nav.getBoundingClientRect();
    const measurements = Array.from(this.links).map((link) => {
      const rect = link.getBoundingClientRect();
      return {
        x: rect.left - navRect.left + 1,
        yTop: rect.top - navRect.top,
        yBot: rect.top - navRect.top + rect.height,
      };
    });
    const measure = (subPath: string): number => {
      this.activePath.setAttribute("d", subPath);
      return this.activePath.getTotalLength();
    };
    const result = createRailPath(measurements, measure);
    this.activePath.setAttribute("d", result.path);
    this.segments = result.segments;
    this.totalLength = result.totalLength;
  }

  private applyActive(index: number, instant: boolean): void {
    const segment = this.segments[index];
    if (!segment) {
      return;
    }

    if (instant) {
      this.activePath.setAttribute("data-initial", "true");
      // Force recalc so only opacity transitions on first paint (no dash sweep).
      void this.activePath.getBoundingClientRect();
    }

    this.activePath.style.strokeDasharray = `${segment.length} ${this.totalLength + 1}`;
    this.activePath.style.strokeDashoffset = String(-segment.start);

    if (instant) {
      requestAnimationFrame(() => {
        this.activePath.setAttribute("data-ready", "true");
        requestAnimationFrame(() => {
          this.activePath.removeAttribute("data-initial");
        });
      });
    }
  }

  private revealActiveLink(link: HTMLElement): void {
    const hostRect = this.scrollHost.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();

    if (linkRect.top < hostRect.top + REVEAL_PADDING) {
      this.scrollHost.scrollTop += linkRect.top - hostRect.top - REVEAL_PADDING;
      return;
    }

    if (linkRect.bottom > hostRect.bottom - REVEAL_PADDING) {
      this.scrollHost.scrollTop +=
        linkRect.bottom - hostRect.bottom + REVEAL_PADDING;
    }
  }

  private setActive(index: number): void {
    if (index === this.currentIndex) {
      return;
    }
    this.currentIndex = index;
    this.currentLink?.removeAttribute("aria-current");
    const activeLink = this.links[index] ?? null;
    activeLink?.setAttribute("aria-current", "true");
    this.currentLink = activeLink;
    if (activeLink) {
      this.revealActiveLink(activeLink);
    }
    this.applyActive(index, !this.hasApplied);
    this.hasApplied = true;
  }

  private resolve(): void {
    if (this.pinnedIndex !== null) {
      this.setActive(this.pinnedIndex);
      return;
    }
    this.setActive(this.atBottom ? this.links.length - 1 : this.observedIndex);
  }

  private handleIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      // SAFETY: only observed heading elements appear as IntersectionObserver targets.
      const index = this.indexOfEl.get(entry.target as HTMLElement);
      if (index === undefined) {
        continue;
      }
      if (entry.isIntersecting) {
        this.inBand.add(index);
      } else {
        this.inBand.delete(index);
      }
    }
    if (this.inBand.size > 0) {
      this.observedIndex = Math.max(...this.inBand);
    }
    this.resolve();
  }

  private updateBottom(): void {
    const scrollElement = document.scrollingElement ?? document.documentElement;
    const maxScroll = scrollElement.scrollHeight - window.innerHeight;
    const next =
      maxScroll > BOTTOM_EPSILON &&
      scrollElement.scrollTop >= maxScroll - BOTTOM_EPSILON;
    if (next !== this.atBottom) {
      this.atBottom = next;
      this.resolve();
    }
  }

  private updateObservedIndex(): void {
    const bandBottom = window.innerHeight * READING_BAND;
    let nextIndex = 0;
    for (const heading of this.observed) {
      if (heading.el.getBoundingClientRect().top <= bandBottom) {
        nextIndex = heading.index;
      } else {
        break;
      }
    }
    this.observedIndex = nextIndex;
  }

  private releaseStalePin(): void {
    if (this.pinnedIndex === null) {
      return;
    }
    const heading = document.getElementById(this.slugs[this.pinnedIndex]);
    if (!heading) {
      this.pinnedIndex = null;
      this.pinnedEnteredViewport = false;
      return;
    }

    const rect = heading.getBoundingClientRect();
    const inViewport = rect.bottom >= 0 && rect.top <= window.innerHeight;
    if (inViewport) {
      this.pinnedEnteredViewport = true;
      return;
    }

    if (this.pinnedEnteredViewport) {
      this.pinnedIndex = null;
      this.pinnedEnteredViewport = false;
    }
  }

  private handleScroll(): void {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    requestAnimationFrame(() => {
      this.updateObservedIndex();
      this.updateBottom();
      this.releaseStalePin();
      this.resolve();
      this.ticking = false;
    });
  }

  private handleLayoutChange(): void {
    this.buildRail();
    this.updateObservedIndex();
    this.updateBottom();
    this.releaseStalePin();
    this.resolve();
    if (this.currentIndex >= 0) {
      this.applyActive(this.currentIndex, true);
      const activeLink = this.links[this.currentIndex];
      if (activeLink) {
        this.revealActiveLink(activeLink);
      }
    }
  }

  private handleNavigationClick(clickEvent: MouseEvent): void {
    if (
      clickEvent.defaultPrevented ||
      clickEvent.button !== 0 ||
      clickEvent.metaKey ||
      clickEvent.ctrlKey ||
      clickEvent.shiftKey ||
      clickEvent.altKey
    ) {
      return;
    }
    // SAFETY: click targets inside the document are Elements; closest handles the rest.
    const link = (clickEvent.target as Element).closest<HTMLElement>(
      "[data-nb-toc-link]",
    );
    if (!link) {
      return;
    }
    const index = this.slugs.indexOf(link.dataset.nbSlug!);
    if (index === -1) {
      return;
    }
    this.pinnedIndex = index;
    const heading = document.getElementById(this.slugs[index]);
    const rect = heading?.getBoundingClientRect();
    this.pinnedEnteredViewport =
      rect !== undefined && rect.bottom >= 0 && rect.top <= window.innerHeight;
    this.resolve();
  }

  private handleNavigationKeydown(keyboardEvent: KeyboardEvent): void {
    if (NAV_KEYS.has(keyboardEvent.key)) {
      this.releasePin();
    }
  }

  private releasePin(): void {
    if (this.pinnedIndex === null) {
      return;
    }
    this.pinnedIndex = null;
    this.pinnedEnteredViewport = false;
    this.resolve();
  }

  private refresh(): void {
    this.buildRail();
    this.updateObservedIndex();
    this.updateBottom();
    this.resolve();
  }
}

mount("[data-nb-toc]", initToc);
