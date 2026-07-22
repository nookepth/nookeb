import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import type { TaskDto } from '@nookeb/shared';
import { listGroupMembers, listTasksForGroup, syncGroupRoster, toTaskDto } from './task.service';

/**
 * ห้องทีม (Team Room) — the group-scoped view of ระบบตามงาน.
 *
 * The tenant key is `group_line_id`, NOT `space_id`. Tasks have always been
 * stored against the LINE group (migration 036: `tasks.space_id` is an
 * informational link only), and a group can be perfectly active before any
 * space exists — a space is created the first time a FILE is stored, which may
 * never happen in a chat that only chases tasks. So the room resolves the space
 * for display (name, file link) and works fine without one.
 *
 * This module holds NO access check. Both callers gate first, by different but
 * equivalent means (the group-id capability, an existing roster row, or space
 * membership) — see routes/spaces.ts and routes/groups.ts.
 */

export interface TeamRoomSpace {
  id: string;
  name: string;
  memberCount: number;
}

export interface TeamRoom {
  /** null when the group has no file space yet — the room still works */
  space: TeamRoomSpace | null;
  groupLineId: string;
  memberCount: number;
  tasks: TaskDto[];
}

export async function getTeamRoom(
  supabase: SupabaseClient,
  redis: Redis,
  groupLineId: string,
): Promise<TeamRoom> {
  // Best-effort roster top-up (throttled per group, never throws) so the member
  // count and assignee names are fresh when the room is opened.
  await syncGroupRoster(supabase, redis, groupLineId);

  const [tasks, members, spaceRow] = await Promise.all([
    listTasksForGroup(supabase, groupLineId),
    listGroupMembers(supabase, groupLineId),
    supabase
      .from('spaces')
      .select('id, name, team_id')
      .eq('line_group_id', groupLineId)
      .eq('type', 'team')
      .maybeSingle()
      .then((r) => (r.data as { id: string; name: string; team_id: string | null } | null) ?? null),
  ]);

  let space: TeamRoomSpace | null = null;
  if (spaceRow) {
    // Prefer the bound team's name over the generic "คลังกลุ่ม" space name.
    let teamName: string | null = null;
    if (spaceRow.team_id) {
      const { data } = await supabase
        .from('teams')
        .select('name')
        .eq('id', spaceRow.team_id)
        .is('deleted_at', null)
        .maybeSingle();
      teamName = ((data as { name: string } | null)?.name) ?? null;
    }
    space = { id: spaceRow.id, name: teamName ?? spaceRow.name, memberCount: members.length };
  }

  return {
    space,
    groupLineId,
    memberCount: members.length,
    tasks: tasks.map(toTaskDto),
  };
}
