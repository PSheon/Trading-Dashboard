import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  FAVORITE_GROUP_COLORS,
  FAVORITE_GROUPS_MAX,
  type CreateFavoriteGroupRequest,
  type FavoriteGroup,
  type PatchFavoriteGroupRequest,
} from "@trading-dashboard/shared/contracts";

import { UnitOfWork } from "../db/unit-of-work.js";
import { FavoriteGroupsRepository, type FavoriteGroupRow } from "./favorite-groups.repository.js";

/**
 * A user's favorites groups (Stage 3 §2.3, CopyDog's watchlist groups):
 * create (at most `FAVORITE_GROUPS_MAX`, unique names), rename / recolour /
 * reorder, delete (the favorites stay), and add or remove members, which
 * must be the user's favorites. Each write runs in one transaction under
 * the user-row lock, so the limit and the next sort order can't race.
 */
@Injectable()
export class FavoriteGroupsService {
  constructor(
    private readonly repository: FavoriteGroupsRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async list(userId: number): Promise<FavoriteGroup[]> {
    const groups = await this.repository.list(userId);
    const members = await this.repository.members(groups.map((g) => g.id));
    return groups.map((g) => toGroup(g, members.get(g.id) ?? []));
  }

  /** @throws ConflictException `group_exists` / `group_limit`. */
  async create(userId: number, input: CreateFavoriteGroupRequest): Promise<FavoriteGroup> {
    const name = input.name.trim();
    const row = await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      if (await this.repository.findByName(tx, userId, name)) throw exists();
      const n = await this.repository.countOwned(tx, userId);
      if (n >= FAVORITE_GROUPS_MAX) {
        throw new ConflictException({ statusCode: 409, code: "group_limit", limit: FAVORITE_GROUPS_MAX, message: `At most ${FAVORITE_GROUPS_MAX} groups` });
      }
      const groups = await this.repository.list(userId, tx);
      const sortOrder = groups.reduce((max, g) => Math.max(max, g.sortOrder + 1), 0);
      const color = input.color ?? FAVORITE_GROUP_COLORS[n % FAVORITE_GROUP_COLORS.length];
      return this.repository.insert(tx, { userId, name, color, sortOrder });
    });
    return toGroup(row, []);
  }

  /** @throws NotFoundException for another user's or a missing group;
   * ConflictException `group_exists` for a name already used. */
  async patch(userId: number, id: number, patch: PatchFavoriteGroupRequest): Promise<FavoriteGroup> {
    await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      const group = await this.repository.findOwned(userId, id, tx);
      if (!group) throw notFound();
      const name = patch.name?.trim();
      if (name !== undefined && name !== group.name && (await this.repository.findByName(tx, userId, name))) throw exists();
      const set: Partial<Pick<FavoriteGroupRow, "name" | "color" | "sortOrder">> = {};
      if (name !== undefined) set.name = name;
      if (patch.color !== undefined) set.color = patch.color;
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
      if (Object.keys(set).length > 0) await this.repository.update(tx, userId, id, set);
    });
    return this.one(userId, id);
  }

  /** Idempotent: deleting a missing group is not an error. */
  async remove(userId: number, id: number): Promise<void> {
    await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      await this.repository.remove(tx, userId, id);
    });
  }

  /** Idempotent. @throws NotFoundException when the group isn't the
   * user's or `address` isn't one of their favorites. */
  async addMember(userId: number, id: number, address: string): Promise<FavoriteGroup> {
    await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      if (!(await this.repository.findOwned(userId, id, tx))) throw notFound();
      if (!(await this.repository.isFavorite(tx, userId, address))) throw new NotFoundException(`${address} is not a favorite`);
      await this.repository.addMember(tx, id, userId, address);
    });
    return this.one(userId, id);
  }

  /** Idempotent. @throws NotFoundException for another user's group. */
  async removeMember(userId: number, id: number, address: string): Promise<void> {
    await this.uow.run(async (tx) => {
      await this.repository.lockUser(tx, userId);
      if (!(await this.repository.findOwned(userId, id, tx))) throw notFound();
      await this.repository.removeMember(tx, id, address);
    });
  }

  private async one(userId: number, id: number): Promise<FavoriteGroup> {
    const group = await this.repository.findOwned(userId, id);
    if (!group) throw notFound();
    const members = await this.repository.members([id]);
    return toGroup(group, members.get(id) ?? []);
  }
}

const toGroup = (row: FavoriteGroupRow, members: string[]): FavoriteGroup => ({
  id: row.id,
  name: row.name,
  color: row.color,
  sortOrder: row.sortOrder,
  members,
  createdAt: row.createdAt,
});
const notFound = () => new NotFoundException("Group not found");
const exists = () => new ConflictException({ statusCode: 409, code: "group_exists", message: "A group with this name exists" });
