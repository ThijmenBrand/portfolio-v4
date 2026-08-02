import type {
  EventHandler,
  EventType,
  KernelEvent,
  Subscription,
} from "./types";

export interface EventBusInterface {
  on<T extends EventType>(
    types: readonly T[],
    handler: EventHandler<T>,
  ): () => void;
  emit(event: KernelEvent): void;
}

export class EventBus implements EventBusInterface {
  private readonly subscriptions: Map<number, Subscription>;
  private nextSubscriptionId: number = 0;

  constructor() {
    this.subscriptions = new Map();
  }

  public on<T extends EventType>(types: T[], cb: EventHandler<T>): () => void {
    const id = this.nextSubscriptionId++;

    this.subscriptions.set(id, {
      id,
      types: new Set(types),
      handler: cb,
      active: true,
    });

    return () => {
      const subscription = this.subscriptions.get(id);
      if (!subscription) return;
      subscription.active = false;
      this.subscriptions.delete(id);
    };
  }

  public emit(event: KernelEvent): void {
    const targets: Subscription[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (subscription.types.has(event.type)) targets.push(subscription);
    }
    if (targets.length === 0) return;

    queueMicrotask(() => {
      for (const subscription of targets) {
        if (!subscription.active) continue;
        try {
          subscription.handler(event);
        } catch (error) {
          console.error(
            `Error in event handler for subscription ${subscription.id} (${event.type}):`,
            error,
          );
        }
      }
    });
  }
}
