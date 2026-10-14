import { expect, it } from "vitest";
import type { DynamicModule, Type } from "@nestjs/common";

import { AppModule } from "../src/app.module.js";

// emitDecoratorMetadata writes a union (`SchedulerService | null`), an
// interface or a type alias as `Object` in a constructor's
// `design:paramtypes`. Nest then looks for a provider whose token is
// `Object`, finds none, and an `@Optional()` parameter quietly gets
// undefined: the worker heartbeat (Stage, 2026-10-14) never saw the
// scheduler whose snapshots it reports. Every constructor parameter of a
// class Nest constructs in the api or a worker must therefore name its
// token: a class type (`scheduler?: SchedulerService`) or an explicit
// `@Inject(...)`.

const PARAMTYPES = "design:paramtypes", SELF_DECLARED = "self:paramtypes";
type Entry = Type | DynamicModule | Promise<DynamicModule> | { forwardRef: () => Type } | undefined;

/** Every class (provider and controller) the module graph rooted at `root` constructs. */
function constructed(root: DynamicModule): Set<Type> {
  const classes = new Set<Type>(), seen = new Set<unknown>();
  const visit = (entry: Entry): void => {
    if (!entry || seen.has(entry) || entry instanceof Promise) return;
    seen.add(entry);
    if ("forwardRef" in entry) return visit(entry.forwardRef());
    const type = (typeof entry === "function" ? entry : entry.module) as Type;
    const dynamic = typeof entry === "function" ? undefined : entry;
    const read = (key: string) => [...(Reflect.getMetadata(key, type) ?? []), ...((dynamic as Record<string, unknown> | undefined)?.[key] as unknown[] ?? [])];
    for (const provider of read("providers")) {
      const cls = typeof provider === "function" ? provider : (provider as { useClass?: Type }).useClass;
      if (cls) classes.add(cls);
    }
    for (const controller of read("controllers")) classes.add(controller as Type);
    for (const imported of read("imports")) visit(imported as Entry);
  };
  visit(root);
  return classes;
}

/** `Class(#index)` for every constructor parameter whose token is `Object` with no `@Inject`. */
function unresolvable(classes: Iterable<Type>): string[] {
  const found: string[] = [];
  for (const cls of classes) {
    const types: unknown[] = Reflect.getMetadata(PARAMTYPES, cls) ?? [];
    const declared = new Set(((Reflect.getMetadata(SELF_DECLARED, cls) ?? []) as { index: number }[]).map((d) => d.index));
    types.forEach((type, index) => { if (type === Object && !declared.has(index)) found.push(`${cls.name}(#${index})`); });
  }
  return found.sort();
}

it("no class in the api or any worker graph has a constructor parameter Nest would look up by the token `Object`", () => {
  const graphs = { api: AppModule.api(), all: AppModule.worker("all"), copy: AppModule.worker("copy"), read: AppModule.worker("read") };
  const classes = new Set<Type>();
  for (const [name, graph] of Object.entries(graphs)) {
    const found = constructed(graph);
    expect(found.size, name).toBeGreaterThan(50);
    for (const cls of found) classes.add(cls);
  }
  expect(unresolvable(classes)).toEqual([]);
});

it("the guard sees a union-typed optional parameter (the heartbeat's old form) and accepts an `@Inject`-ed one", async () => {
  const { Inject, Injectable, Optional } = await import("@nestjs/common");
  class Dependency {}
  @Injectable() class Union { constructor(@Optional() readonly dependency: Dependency | null) {} }
  @Injectable() class Injected { constructor(@Optional() @Inject(Dependency) readonly dependency: Dependency | null) {} }
  @Injectable() class Questioned { constructor(@Optional() readonly dependency?: Dependency) {} }
  expect(unresolvable([Union, Injected, Questioned])).toEqual(["Union(#0)"]);
});
