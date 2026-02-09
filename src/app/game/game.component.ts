import { DecimalPipe } from '@angular/common';
import {
  Component,
  signal,
  computed,
  OnInit,
  OnDestroy,
  AfterViewInit,
  HostListener,
  ElementRef,
  viewChild,
  inject,
  ChangeDetectorRef,
} from '@angular/core';

const SPAWN_INTERVAL_MS = 900;
const MAX_BUGS = 10;
const GRAB_CAPACITY = 1;
const BUG_WANDER_SPEED = 0.06;
const DIP_DAMAGE_PER_FRAME = 0.4;

const BUG_TYPES = [
  { label: 'NullPointerException', icon: '🐞' },
  { label: '404 Not Found', icon: '🐞' },
  { label: 'Infinite Loop', icon: '🐞' },
  { label: 'Segmentation Fault', icon: '🐞' },
  { label: 'Syntax Error', icon: '🐞' },
  { label: 'Out of Memory', icon: '🐞' },
  { label: 'Stack Overflow', icon: '🐞' },
  { label: 'Race Condition', icon: '🐞' },
];

interface Bug {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: (typeof BUG_TYPES)[number];
}

interface AttachedBug {
  bug: Bug;
  offsetY: number;
  health: number;
}

@Component({
  selector: 'app-game',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './game.component.html',
  styleUrl: './game.component.css',
})
export class GameComponent implements OnInit, OnDestroy, AfterViewInit {
  private cdr = inject(ChangeDetectorRef);
  private spawnInterval: ReturnType<typeof setInterval> | null = null;
  private gameLoop: ReturnType<typeof requestAnimationFrame> | null = null;

  readonly bugs = signal<Bug[]>([]);
  readonly attachedBugs = signal<AttachedBug[]>([]);
  readonly score = signal(0);
  readonly isPlaying = signal(true);
  readonly showSettings = signal(false);
  readonly showAbout = signal(false);
  readonly isDarkTheme = signal(true);

  /** Floating laugh emojis when bugs are killed */
  readonly laughEmojis = signal<{ id: number; x: number; y: number; emoji: string }[]>([]);
  private nextLaughId = 0;
  readonly burnStreak = signal(0);
  private lastBurnTime = 0;

  readonly mouseX = signal(0);
  readonly mouseY = signal(0);
  readonly isDragging = signal(false);

  /** On mobile, show grabbed bug above the finger so it's not hidden. */
  readonly isMobile = signal(false);
  private readonly ATTACH_OFFSET_DESKTOP = 40;
  private readonly ATTACH_OFFSET_MOBILE = 110;

  private nextBugId = 0;
  private gameRect: DOMRect = new DOMRect();
  private screenRect: DOMRect = new DOMRect();
  private tubRect: DOMRect = new DOMRect();

  gameAreaRef = viewChild<ElementRef<HTMLElement>>('gameArea');
  screenRef = viewChild<ElementRef<HTMLElement>>('screen');
  tubRef = viewChild<ElementRef<HTMLElement>>('tub');

  readonly tick = signal(0);

  readonly bugsToRender = computed(() => {
    this.tick();
    const allBugs = this.bugs();
    const attached = this.attachedBugs();
    const attachedIds = new Set(attached.map((a) => a.bug.id));
    const vx = this.mouseX();
    const vy = this.mouseY();
    const r = this.gameRect;

    const result: {
      bug: Bug;
      x: number;
      y: number;
      attached: boolean;
      health: number;
    }[] = [];

    for (const bug of allBugs) {
      if (attachedIds.has(bug.id)) {
        const a = attached.find((x) => x.bug.id === bug.id);
        if (a && r.width) {
          const { x: px, y: py } = this.clientToPercent(vx, vy + a.offsetY);
          result.push({
            bug,
            x: px,
            y: py,
            attached: true,
            health: a.health,
          });
        }
      } else {
        result.push({
          bug,
          x: bug.x,
          y: bug.y,
          attached: false,
          health: 100,
        });
      }
    }
    return result;
  });

  readonly stressRelieved = computed(() => {
    const s = this.score();
    return Math.min(100, Math.floor(s * 10));
  });

  readonly devSatisfaction = computed(() => this.stressRelieved());

  readonly LAUGH_EMOJIS = ['😂', '🤣', '😆', '💀', '🔥'];

  readonly funnyEndMessages = [
    "You've drowned your stress. Literally.",
    'Bugs: soaked. Mood: elevated. 💧',
    'That was satisfying. Admit it.',
    'Your codebase is water-logged. In a good way.',
    'Purge complete. Breathe.',
  ];

  ngOnInit(): void {
    this.startSpawning();
  }

  ngAfterViewInit(): void {
    this.detectMobile();
    this.initGameArea();
  }

  private detectMobile(): void {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const narrow = window.matchMedia('(max-width: 768px)').matches;
    this.isMobile.set(coarse || narrow);
  }

  ngOnDestroy(): void {
    this.stopTimers();
    if (this.gameLoop) cancelAnimationFrame(this.gameLoop);
  }

  private initGameArea(): void {
    const updateRects = () => {
      this.gameAreaRef()?.nativeElement &&
        (this.gameRect = this.gameAreaRef()!.nativeElement.getBoundingClientRect());
      this.screenRef()?.nativeElement &&
        (this.screenRect = this.screenRef()!.nativeElement.getBoundingClientRect());
      this.tubRef()?.nativeElement &&
        (this.tubRect = this.tubRef()!.nativeElement.getBoundingClientRect());
    };
    updateRects();
    const ga = this.gameAreaRef()?.nativeElement;
    if (ga) {
      const observer = new ResizeObserver(updateRects);
      observer.observe(ga);
    }
    this.startGameLoop();
  }

  private startGameLoop(): void {
    const tick = () => {
      this.tick.update((v) => v + 1);
      if (!this.isPlaying()) {
        this.gameLoop = requestAnimationFrame(tick);
        return;
      }
      this.updateBugPositions();
      this.updateDipping();
      this.cdr.detectChanges();
      this.gameLoop = requestAnimationFrame(tick);
    };
    this.gameLoop = requestAnimationFrame(tick);
  }

  private updateBugPositions(): void {
    const attachedIds = new Set(this.attachedBugs().map((a) => a.bug.id));
    this.bugs.update((list) =>
      list.map((bug) => {
        if (attachedIds.has(bug.id)) return bug;
        let nx = bug.x + bug.vx;
        let ny = bug.y + bug.vy;
        if (nx < 5 || nx > 95) nx = bug.x;
        if (ny < 5 || ny > 95) ny = bug.y;
        return {
          ...bug,
          x: nx,
          y: ny,
          vx: nx === bug.x ? -bug.vx : bug.vx,
          vy: ny === bug.y ? -bug.vy : bug.vy,
        };
      })
    );
  }

  private isInTub(clientX: number, clientY: number): boolean {
    const t = this.tubRect;
    if (!t.width || !t.height) return false;
    return (
      clientX >= t.left &&
      clientX <= t.right &&
      clientY >= t.top &&
      clientY <= t.bottom
    );
  }

  private updateDipping(): void {
    const attached = this.attachedBugs();
    if (attached.length === 0) return;

    const vx = this.mouseX();
    const vy = this.mouseY();
    const dipped = this.isInTub(vx, vy);

    const updated: AttachedBug[] = [];
    const toRemove: Bug[] = [];

    for (const a of attached) {
      if (dipped) {
        const newHealth = Math.max(0, a.health - DIP_DAMAGE_PER_FRAME);
        if (newHealth <= 0) {
          toRemove.push(a.bug);
        } else {
          updated.push({ ...a, health: newHealth });
        }
      } else {
        updated.push(a);
      }
    }

    if (toRemove.length > 0) {
      this.attachedBugs.set(updated.filter((a) => !toRemove.some((b) => b.id === a.bug.id)));
      const now = Date.now();
      const streak = now - this.lastBurnTime < 3000 ? this.burnStreak() + 1 : 1;
      this.lastBurnTime = now;
      this.burnStreak.set(streak);
      for (const bug of toRemove) {
        this.bugs.update((list) => list.filter((b) => b.id !== bug.id));
        this.score.update((s) => s + 1);
        this.spawnLaughEmoji();
      }
    } else {
      this.attachedBugs.set(updated);
    }
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent): void {
    this.mouseX.set(e.clientX);
    this.mouseY.set(e.clientY);
  }

  @HostListener('document:touchmove', ['$event'])
  onTouchMove(e: TouchEvent): void {
    if (e.touches.length) {
      this.mouseX.set(e.touches[0].clientX);
      this.mouseY.set(e.touches[0].clientY);
    }
  }

  private clientToPercent(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.gameRect;
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: ((clientX - r.left) / r.width) * 100,
      y: ((clientY - r.top) / r.height) * 100,
    };
  }

  private getRandomScreenPosition(): { x: number; y: number } {
    return {
      x: 10 + Math.random() * 80,
      y: 10 + Math.random() * 80,
    };
  }

  private startSpawning(): void {
    this.spawnInterval = setInterval(() => {
      if (!this.isPlaying()) return;
      const current = this.bugs();
      const attached = this.attachedBugs();
      const freeCount = current.length - attached.length;
      if (freeCount >= MAX_BUGS) return;

      const type = BUG_TYPES[Math.floor(Math.random() * BUG_TYPES.length)];
      const { x, y } = this.getRandomScreenPosition();
      const angle = Math.random() * Math.PI * 2;

      this.bugs.update((list) => [
        ...list,
        {
          id: `bug-${++this.nextBugId}`,
          x,
          y,
          vx: Math.cos(angle) * BUG_WANDER_SPEED,
          vy: Math.sin(angle) * BUG_WANDER_SPEED,
          type,
        },
      ]);
    }, SPAWN_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.spawnInterval) {
      clearInterval(this.spawnInterval);
      this.spawnInterval = null;
    }
  }

  private hitTestScreen(clientX: number, clientY: number): Bug | null {
    const s = this.screenRect;
    if (!s.width || !s.height) return null;
    const attachedIds = new Set(this.attachedBugs().map((a) => a.bug.id));
    const freeBugs = this.bugs().filter((b) => !attachedIds.has(b.id));

    const sx = ((clientX - s.left) / s.width) * 100;
    const sy = ((clientY - s.top) / s.height) * 100;
    const hitRadius = this.isMobile() ? 20 : 14; /* larger hit area on touch */

    for (const bug of freeBugs) {
      const dist = Math.hypot(sx - bug.x, sy - bug.y);
      if (dist < hitRadius) return bug;
    }
    return null;
  }

  onPointerDown(clientX: number, clientY: number): void {
    if (!this.isPlaying()) return;
    this.isDragging.set(true);

    const hit = this.hitTestScreen(clientX, clientY);
    const attached = this.attachedBugs();

    if (hit && attached.length < GRAB_CAPACITY) {
      const offsetY = this.isMobile() ? this.ATTACH_OFFSET_MOBILE : this.ATTACH_OFFSET_DESKTOP;
      this.attachedBugs.update((list) => [
        ...list,
        { bug: hit, offsetY, health: 100 },
      ]);
    }
  }

  onPointerUp(): void {
    this.attachedBugs.set([]);
    this.isDragging.set(false);
  }

  onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    this.onPointerDown(e.clientX, e.clientY);
  }

  onMouseUp(): void {
    this.onPointerUp();
  }

  onPointerUpForLeave(): void {
    this.onPointerUp();
  }

  onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length) {
      const t = e.touches[0];
      this.mouseX.set(t.clientX);
      this.mouseY.set(t.clientY);
      this.onPointerDown(t.clientX, t.clientY);
    }
  }

  onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    if (e.changedTouches.length) {
      this.onPointerUp();
    } else {
      this.isDragging.set(false);
    }
  }

  toggleSettings(): void {
    this.showAbout.set(false);
    this.showSettings.update((v) => !v);
  }

  toggleAbout(): void {
    this.showSettings.set(false);
    this.showAbout.update((v) => !v);
  }

  readonly keyboardRows: (string | number)[][] = [
    [1,2,3,4,5,6,7,8,9,10],
    [11,12,13,14,15,16,17,18,19],
    [21,22,23,24,25,26,27],
    ['space'],
  ];


  private spawnLaughEmoji(): void {
    const mx = this.mouseX();
    const my = this.mouseY();
    const r = this.gameRect;
    const x = r.width ? ((mx - r.left) / r.width) * 100 : 50;
    const y = r.height ? ((my - r.top) / r.height) * 100 : 50;
    const emoji = this.LAUGH_EMOJIS[Math.floor(Math.random() * this.LAUGH_EMOJIS.length)];
    const id = ++this.nextLaughId;
    this.laughEmojis.update((list) => [...list, { id, x, y, emoji }]);
    setTimeout(() => {
      this.laughEmojis.update((list) => list.filter((e) => e.id !== id));
    }, 1200);
  }
}
