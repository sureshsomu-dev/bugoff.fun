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
const DIP_DAMAGE_BASE = 0.4;

const BUG_SIZES = ['small', 'medium', 'large'] as const;
const GIANT_BUG_FIRST_DELAY_MS = 60_000;
const GIANT_BUG_INTERVAL_MS = 60_000;
const FUNCTIONALITY_BREAK_LABEL = 'Critical: functionality break';

type BugSize = (typeof BUG_SIZES)[number] | 'giant';

/** Single bug icon for all bugs — throw into fire */
const BUG_ICON = '🐞';

/** Realistic, funny dev & UX bugs — what we actually face */
const BUG_TYPES = [
  /* Classic / backend */
  'NullPointerException',
  '404 Not Found',
  '500 Internal Server Error',
  'Works on my machine',
  'Infinite loop',
  'Stack overflow',
  'Out of memory',
  'Race condition',
  'Segmentation fault',
  'Syntax error',
  'Off-by-one error',
  'Cache invalidation',
  'CORS policy',
  'Timezone bug',
  'Heisenbug',
  'Bohrbug',
  /* UX / frontend */
  'Button too small to tap',
  'Modal won\'t close',
  'Infinite loading spinner',
  'Form resets on tab',
  'Hamburger menu mystery',
  '3px alignment bug',
  'Just one more click',
  'Scroll hijacking',
  'Tap target 8px',
  'Focus trap in modal',
  'Broken back button',
  'Skeleton never loads',
  'Placeholder as label',
  'Cookie banner forever',
  'Captcha not loading',
  /* Process / PM humor */
  'PM said ship it',
  'Legacy code',
  'Spaghetti code',
  'It\'s a feature',
  'Known unknown',
  'Works only on dev',
  'Only on client laptop',
  'Unknown issue',
  'Won\'t fix',
  'By design',
  'Duplicate of #9999',
];

interface Bug {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  typeLabel: string;
  size: BugSize;
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
  private giantBugInterval: ReturnType<typeof setInterval> | null = null;
  private giantBugFirstTimeout: ReturnType<typeof setTimeout> | null = null;
  private sessionStartTime = 0;
  private gameLoop: ReturnType<typeof requestAnimationFrame> | null = null;
  private audioContext: AudioContext | null = null;
  private fireSoundSource: AudioBufferSourceNode | null = null;
  private fireSoundGain: GainNode | null = null;
  private fireSoundPlaying = false;
  private wasBurning = false;
  private fireCrackInterval: ReturnType<typeof setInterval> | null = null;
  private crickeInterval: ReturnType<typeof setInterval> | null = null;

  readonly bugs = signal<Bug[]>([]);
  readonly attachedBugs = signal<AttachedBug[]>([]);
  readonly score = signal(0);
  readonly isPlaying = signal(true);
  readonly showSettings = signal(false);
  readonly showAbout = signal(false);
  readonly isDarkTheme = signal(true);

  /** Destruction effect: fire, water, void, ice */
  readonly effectType = signal<'fire' | 'water' | 'void' | 'ice'>('fire');
  /** Effect size for the pit */
  readonly effectSize = signal<'small' | 'medium' | 'large'>('medium');

  readonly EFFECT_OPTIONS: { value: 'fire' | 'water' | 'void' | 'ice'; label: string; icon: string }[] = [
    { value: 'fire', label: 'Fire', icon: '🔥' },
    { value: 'water', label: 'Water', icon: '💧' },
    { value: 'void', label: 'Void', icon: '🕳️' },
    { value: 'ice', label: 'Ice', icon: '❄️' },
  ];
  readonly SIZE_OPTIONS: { value: 'small' | 'medium' | 'large'; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
  ];

  readonly bugIcon = BUG_ICON;

  /** Current attached bug + health — tick() forces re-run every frame so graph/UI stay in sync */
  readonly currentAttachedBug = computed(() => {
    this.tick();
    return this.attachedBugs()[0] ?? null;
  });

  /** Giant bug (Functionality break) — only one at a time */
  readonly giantBug = computed(() => this.bugs().find((b) => b.size === 'giant') ?? null);

  /** Giant when not grabbed — show as modal overlay (not from laptop) */
  readonly freeGiantBug = computed(() => {
    const g = this.giantBug();
    if (!g) return null;
    if (this.attachedBugs().some((a) => a.bug.id === g.id)) return null;
    return g;
  });

  /** In effect zone taking damage — tick() so ashes/particles show every time */
  readonly isBugInEffect = computed(() => {
    this.tick();
    const a = this.attachedBugs()[0];
    return a != null && a.health > 0 && a.health < 100;
  });

  /** Damage per frame when in effect zone — scales with effect size (larger = more damage) */
  private getDipDamagePerFrame(): number {
    const size = this.effectSize();
    switch (size) {
      case 'small': return DIP_DAMAGE_BASE * 0.5;
      case 'medium': return DIP_DAMAGE_BASE;
      case 'large': return DIP_DAMAGE_BASE * 2;
      default: return DIP_DAMAGE_BASE;
    }
  }

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

  /** Rolling LOL reaction emojis only (no thumbs/stars) */
  readonly LOL_EMOJIS = ['😂', '🤣', '😁'] as const;

  readonly funnyEndMessages = [
    "You've drowned your stress. Literally.",
    'Bugs: soaked. Mood: elevated. 💧',
    'That was satisfying. Admit it.',
    'Your codebase is water-logged. In a good way.',
    'Purge complete. Breathe.',
  ];

  ngOnInit(): void {
    this.sessionStartTime = Date.now();
    this.startSpawning();
    this.startGiantBugSpawning();
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

    const damagePerFrame = this.getDipDamagePerFrame();
    for (const a of attached) {
      if (dipped) {
        const newHealth = Math.max(0, a.health - damagePerFrame);
        if (newHealth <= 0) {
          toRemove.push(a.bug);
        } else {
          updated.push({ ...a, health: newHealth });
        }
      } else {
        updated.push(a);
      }
    }

    const burning = dipped && updated.some((a) => a.health > 0);
    if (burning) {
      if (!this.wasBurning) this.playBurnSizzle();
      this.wasBurning = true;
      this.startFireSound();
    } else {
      this.wasBurning = false;
      this.stopFireSound();
    }

    if (toRemove.length > 0) {
      this.stopFireSound();
      this.playKillSound();
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

      const typeLabel = BUG_TYPES[Math.floor(Math.random() * BUG_TYPES.length)];
      const { x, y } = this.getRandomScreenPosition();
      const angle = Math.random() * Math.PI * 2;

      const size: BugSize = BUG_SIZES[Math.floor(Math.random() * BUG_SIZES.length)];
      this.bugs.update((list) => [
        ...list,
        {
          id: `bug-${++this.nextBugId}`,
          x,
          y,
          vx: Math.cos(angle) * BUG_WANDER_SPEED,
          vy: Math.sin(angle) * BUG_WANDER_SPEED,
          typeLabel,
          size,
        },
      ]);
    }, SPAWN_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.spawnInterval) {
      clearInterval(this.spawnInterval);
      this.spawnInterval = null;
    }
    if (this.giantBugFirstTimeout) {
      clearTimeout(this.giantBugFirstTimeout);
      this.giantBugFirstTimeout = null;
    }
    if (this.giantBugInterval) {
      clearInterval(this.giantBugInterval);
      this.giantBugInterval = null;
    }
  }

  private spawnGiantBug(): void {
    if (this.bugs().some((b) => b.size === 'giant')) return;
    this.bugs.update((list) => [
      ...list,
      {
        id: `bug-giant-${++this.nextBugId}`,
        x: 50,
        y: 50,
        vx: 0,
        vy: 0,
        typeLabel: FUNCTIONALITY_BREAK_LABEL,
        size: 'giant',
      },
    ]);
  }

  private startGiantBugSpawning(): void {
    this.giantBugFirstTimeout = setTimeout(() => {
      this.giantBugFirstTimeout = null;
      if (this.isPlaying()) this.spawnGiantBug();
      this.giantBugInterval = setInterval(() => {
        if (!this.isPlaying()) return;
        this.spawnGiantBug();
      }, GIANT_BUG_INTERVAL_MS);
    }, GIANT_BUG_FIRST_DELAY_MS);
  }

  private isInGameRect(clientX: number, clientY: number): boolean {
    const r = this.gameRect;
    return r.width > 0 && r.height > 0 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  private hitTestScreen(clientX: number, clientY: number): Bug | null {
    const attachedIds = new Set(this.attachedBugs().map((a) => a.bug.id));
    const freeBugs = this.bugs().filter((b) => !attachedIds.has(b.id));

    const giant = freeBugs.find((b) => b.size === 'giant');
    if (giant && this.isInGameRect(clientX, clientY)) return giant;

    const s = this.screenRect;
    if (!s.width || !s.height) return null;
    const sx = ((clientX - s.left) / s.width) * 100;
    const sy = ((clientY - s.top) / s.height) * 100;
    const hitRadius = this.isMobile() ? 24 : 14;

    for (const bug of freeBugs) {
      if (bug.size === 'giant') continue;
      const dist = Math.hypot(sx - bug.x, sy - bug.y);
      if (dist < hitRadius) return bug;
    }
    return null;
  }

  onPointerDown(clientX: number, clientY: number): void {
    this.ensureAudioContext();
    if (!this.isPlaying()) return;
    this.isDragging.set(true);

    const hit = this.hitTestScreen(clientX, clientY);
    const attached = this.attachedBugs();

    if (hit && attached.length < GRAB_CAPACITY) {
      this.playGrabSound();
      const offsetY = this.isMobile() ? this.ATTACH_OFFSET_MOBILE : this.ATTACH_OFFSET_DESKTOP;
      this.attachedBugs.update((list) => [
        ...list,
        { bug: hit, offsetY, health: 100 },
      ]);
    }
  }

  private ensureAudioContext(): void {
    if (typeof window === 'undefined') return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }
    if (!this.audioContext) {
      this.audioContext = new Ctx();
    }
  }

  private playGrabSound(): void {
    try {
      const ctx = this.audioContext;
      if (!ctx || ctx.state !== 'running') return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.setValueAtTime(280, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(360, ctx.currentTime + 0.06);
      o.type = 'sine';
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.08);
    } catch {
      // ignore
    }
  }

  private playKillSound(): void {
    try {
      const ctx = this.audioContext;
      if (!ctx || ctx.state !== 'running') return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = 'sine';
      o.frequency.setValueAtTime(400, ctx.currentTime);
      o.frequency.setValueAtTime(600, ctx.currentTime + 0.08);
      o.frequency.setValueAtTime(800, ctx.currentTime + 0.16);
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.25);
    } catch {
      // ignore
    }
  }

  private startFireSound(): void {
    if (this.fireSoundPlaying) return;
    this.ensureAudioContext();
    try {
      const ctx = this.audioContext;
      if (!ctx || ctx.state !== 'running') return;
      const sr = ctx.sampleRate;
      const length = Math.floor(sr * 0.4);
      const buffer = ctx.createBuffer(1, length, sr);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.5;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1100;
      filter.Q.value = 0.5;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.05);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      this.fireSoundSource = source;
      this.fireSoundGain = gain;
      this.fireSoundPlaying = true;

      this.playStickCrack();
      this.fireCrackInterval = setInterval(() => this.playStickCrack(), 380 + Math.random() * 220);

      this.playCrickeCricke();
      this.crickeInterval = setInterval(() => this.playCrickeCricke(), 1800);
    } catch {
      // ignore
    }
  }

  private stopFireSound(): void {
    if (this.fireCrackInterval) {
      clearInterval(this.fireCrackInterval);
      this.fireCrackInterval = null;
    }
    if (this.crickeInterval) {
      clearInterval(this.crickeInterval);
      this.crickeInterval = null;
    }
    if (!this.fireSoundPlaying || !this.audioContext || !this.fireSoundSource || !this.fireSoundGain) return;
    try {
      const ctx = this.audioContext;
      const gain = this.fireSoundGain;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.08);
      this.fireSoundSource.stop(ctx.currentTime + 0.08);
    } catch {
      // ignore
    }
    this.fireSoundSource = null;
    this.fireSoundGain = null;
    this.fireSoundPlaying = false;
  }

  /** Two repetitive cricket/insect chirps – "cricke cricke" while burning */
  private playCrickeCricke(): void {
    try {
      const ctx = this.audioContext;
      if (!ctx || ctx.state !== 'running') return;
      const playOne = (t: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(2600, ctx.currentTime + t);
        g.gain.setValueAtTime(0, ctx.currentTime + t);
        g.gain.linearRampToValueAtTime(0.03, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.002, ctx.currentTime + t + 0.045);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.045);
      };
      playOne(0);
      playOne(0.12);
    } catch {
      // ignore
    }
  }

  /** Sticks burning – short crackle/pop */
  private playStickCrack(): void {
    try {
      const ctx = this.audioContext;
      if (!ctx || ctx.state !== 'running') return;
      const sr = ctx.sampleRate;
      const length = Math.floor(sr * 0.03);
      const buffer = ctx.createBuffer(1, length, sr);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.6;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 700;
      filter.Q.value = 0.3;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(ctx.currentTime);
      source.stop(ctx.currentTime + 0.03);
    } catch {
      // ignore
    }
  }

  private playBurnSizzle(): void {
    try {
      const ctx = this.audioContext;
      if (!ctx || ctx.state !== 'running') return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(120, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.15);
      g.gain.setValueAtTime(0.06, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.005, ctx.currentTime + 0.15);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.15);
    } catch {
      // ignore
    }
  }

  onPointerUp(): void {
    this.stopFireSound();
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

  onTouchCancel(e: TouchEvent): void {
    e.preventDefault();
    this.onPointerUp();
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


  /** Spawn reactions on top of dev icon (left side), then rise to top */
  private readonly REACTION_SPAWN_X = 4;
  private readonly REACTION_SPAWN_Y = 48;

  private spawnLaughEmoji(): void {
    const r = this.gameRect;
    const baseX = r.width ? this.REACTION_SPAWN_X : 50;
    const baseY = r.height ? this.REACTION_SPAWN_Y : 50;
    const count = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const spread = 8;
      const x = baseX + (Math.random() - 0.5) * spread;
      const y = baseY + (Math.random() - 0.5) * 6;
      const id = ++this.nextLaughId;
      const emoji = this.LOL_EMOJIS[Math.floor(Math.random() * this.LOL_EMOJIS.length)];
      this.laughEmojis.update((list) => [...list, { id, x, y, emoji }]);
      setTimeout(() => {
        this.laughEmojis.update((list) => list.filter((e) => e.id !== id));
      }, 2600);
    }
  }
}
