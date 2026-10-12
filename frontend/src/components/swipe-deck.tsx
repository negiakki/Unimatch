"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cx } from "@/lib/format";

/**
 * A tactile swipe deck built on Pointer Events and direct style writes.
 *
 * Deliberately dependency-free: dragging mutates `style.transform` on the
 * card element instead of going through React state, so the card tracks the
 * finger at frame rate with no re-render per pointermove. React state is only
 * used for the things that must re-render — the committed direction and the
 * busy flag.
 *
 * Physics: horizontal translation with damped vertical, rotation proportional to
 * distance, and velocity-aware commit (a fast flick commits even if it hasn't
 * travelled far). `touch-action: pan-y` keeps vertical page scrolling native.
 *
 * The deck owns the exit animation and signals `onAdvance` when it's done, so
 * a swipe and a button press take exactly the same path and look identical.
 *
 * Under `prefers-reduced-motion` the rotation and travel are dropped and the
 * card cross-fades instead — the gesture still works, it just doesn't move.
 */

export type SwipeDirection = "pass" | "interested";

const COMMIT_DISTANCE = 84;
const COMMIT_VELOCITY = 0.5; // px per ms — a flick beats distance
const ROTATION_AT_FULL = 14; // degrees
const EXIT_DURATION = 240;
const REDUCED_EXIT_DURATION = 170;
const RETURN_DURATION = 300;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function SwipeDeck<T>({
  items,
  getKey,
  render,
  onDecide,
  onAdvance,
  busy,
  onBusyChange,
  command,
  onCommandHandled,
  stamps,
  className,
}: {
  items: T[];
  getKey: (item: T) => string;
  /** Card content. `isTop` is false for the card behind, which is decorative. */
  render: (item: T, isTop: boolean) => ReactNode;
  /** Records the action. Fired at the moment of the gesture, not after. */
  onDecide: (item: T, direction: SwipeDirection) => void;
  /** Drops the decided card from `items` once the exit animation has played. */
  onAdvance: () => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Non-gesture trigger: set a direction to run the identical gesture. */
  command: SwipeDirection | null;
  onCommandHandled: () => void;
  /** Directional feedback stamps: [passLabel, interestedLabel]. */
  stamps: [string, string];
  className?: string;
}) {
  const top = items[0];
  const next = items[1];

  const cardRef = useRef<HTMLDivElement | null>(null);
  const passStampRef = useRef<HTMLSpanElement | null>(null);
  const wantStampRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const drag = useRef({
    active: false,
    startX: 0,
    startY: 0,
    dx: 0,
    lastX: 0,
    lastAt: 0,
    velocity: 0,
  });

  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const resetStamps = useCallback(() => {
    for (const stamp of [passStampRef.current, wantStampRef.current]) {
      if (stamp) {
        stamp.style.opacity = "0";
      }
    }
  }, []);

  const paint = useCallback((dx: number, dy: number) => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const reduced = prefersReducedMotion();
    const rotate = reduced
      ? 0
      : clamp((dx / COMMIT_DISTANCE) * ROTATION_AT_FULL, -22, 22);
    card.style.transform = `translate3d(${
      reduced ? dx * 0.12 : dx
    }px, ${reduced ? 0 : dy * 0.35}px, 0) rotate(${rotate}deg)`;

    const strength = clamp(Math.abs(dx) / COMMIT_DISTANCE, 0, 1);
    const pass = passStampRef.current;
    const want = wantStampRef.current;
    if (pass) {
      pass.style.opacity = dx < 0 ? String(strength) : "0";
    }
    if (want) {
      want.style.opacity = dx > 0 ? String(strength) : "0";
    }
  }, []);

  const settle = useCallback(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    card.style.transition = `transform ${RETURN_DURATION}ms var(--ease-out)`;
    card.style.transform = "";
    resetStamps();
  }, [resetStamps]);

  const decide = useCallback(
    (direction: SwipeDirection) => {
      if (busy || !top) {
        return;
      }
      onBusyChange(true);

      // Record the action and animate out together: the wait belongs to the
      // network, not to the gesture.
      onDecide(top, direction);

      const card = cardRef.current;
      const reduced = prefersReducedMotion();
      drag.current.active = false;
      setDragging(false);
      if (card) {
        card.style.transition = reduced
          ? "opacity 160ms ease-out"
          : `transform ${EXIT_DURATION}ms var(--ease-out), opacity ${EXIT_DURATION}ms ease-out`;
        card.style.transform = reduced
          ? ""
          : `translate3d(${
              direction === "pass" ? "-130%" : "130%"
            }%, -6%, 0) rotate(${direction === "pass" ? -18 : 18}deg)`;
        card.style.opacity = "0";
      }
      // Only now does the card leave the list, so the exit is actually seen.
      timerRef.current = window.setTimeout(() => {
        onAdvance();
        onBusyChange(false);
        timerRef.current = null;
      }, reduced ? REDUCED_EXIT_DURATION : EXIT_DURATION);
    },
    [busy, onAdvance, onBusyChange, onDecide, top],
  );

  // A button press replays the same gesture, so the exit looks identical.
  useEffect(() => {
    void (async () => {
      if (command && !busy) {
        decide(command);
        onCommandHandled();
      }
    })();
  }, [busy, command, decide, onCommandHandled]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (busy || drag.current.active || event.button !== 0) {
      return;
    }
    const card = cardRef.current;
    if (card) {
      card.style.transition = "";
      card.setPointerCapture(event.pointerId);
    }
    drag.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      lastX: event.clientX,
      lastAt: event.timeStamp,
      velocity: 0,
    };
    setDragging(true);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state.active) {
      return;
    }
    const dx = event.clientX - state.startX;
    state.dx = dx;

    // Instantaneous velocity over a short window: robust against jank.
    const elapsed = event.timeStamp - state.lastAt;
    if (elapsed > 8) {
      state.velocity = (event.clientX - state.lastX) / elapsed;
      state.lastX = event.clientX;
      state.lastAt = event.timeStamp;
    }

    paint(dx, event.clientY - state.startY);
  }

  function handlePointerUp() {
    const state = drag.current;
    if (!state.active) {
      return;
    }
    state.active = false;
    setDragging(false);

    const committed =
      Math.abs(state.dx) >= COMMIT_DISTANCE ||
      Math.abs(state.velocity) >= COMMIT_VELOCITY;

    if (committed && top) {
      decide(state.dx < 0 ? "pass" : "interested");
      return;
    }
    settle();
  }

  if (!top) {
    return null;
  }

  return (
    <div className={cx("relative", className)}>
      {/* The card behind, giving the stack depth. */}
      {next && (
        <div
          aria-hidden
          className="absolute inset-x-0 top-3 origin-top scale-[0.95] opacity-60 transition-transform duration-300"
        >
          {render(next, false)}
        </div>
      )}

      <div
        key={getKey(top)}
        ref={cardRef}
        data-swipe-card
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ touchAction: "pan-y", cursor: dragging ? "grabbing" : "grab" }}
        className="relative select-none"
      >
        {/* Directional feedback, painted per frame during the drag. */}
        <Stamp ref={passStampRef} side="left" label={stamps[0]} />
        <Stamp ref={wantStampRef} side="right" label={stamps[1]} />
        {render(top, true)}
      </div>
    </div>
  );
}

function Stamp({
  ref,
  side,
  label,
}: {
  ref: React.RefObject<HTMLSpanElement | null>;
  side: "left" | "right";
  label: string;
}) {
  return (
    <span
      ref={ref}
      aria-hidden
      style={{ opacity: 0 }}
      className={cx(
        "type-meta pointer-events-none absolute top-8 z-10 rounded-full border-2 px-4 py-2",
        "transition-opacity duration-100",
        side === "left"
          ? "-left-2 -rotate-12 border-ink text-ink"
          : "-right-2 rotate-12 border-accent text-accent",
      )}
    >
      {label}
    </span>
  );
}