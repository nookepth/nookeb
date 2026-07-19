import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import ical, { ICalAlarmType, ICalEventRepeatingFreq } from 'ical-generator';
import type { RecurrenceRule, TaskDto } from '@nookeb/shared';
import { pushMessage } from '../services/line.service';
import { buildTaskCreatedFlex } from '../services/lineMessage';
import { logEvent } from '../services/events.service';
import {
  addTaskLink,
  cancelTask,
  createTaskWithItems,
  deleteTaskLink,
  effectiveDeadline,
  getTaskWithDetails,
  ensureGroupMember,
  isGroupMember,
  listGroupMembers,
  listTasksForUser,
  markAssigneeAccepted,
  markAssigneeDone,
  replaceItemAssignees,
  rollUpCompletion,
  setDoneNote,
  toTaskDto,
  updateTask,
  type TaskWithDetails,
} from '../services/task.service';
import {
  cancelReminders,
  computeNextOccurrence,
  rescheduleReminders,
  scheduleReminders,
} from '../services/taskScheduler';

/**
 * ระบบตามงาน (Task Manager) API — migration 036. Tasks are created from the
 * LIFF web flow; the announcement + scheduled reminders go out as pushes (the
 * feature's sanctioned exception to reply-only messaging — see line.service.ts).
 *
 * Tenant guard: every authenticated route checks the caller's line_uid against
 * group_members for the task's group (service role bypasses RLS — rule 4).
 */

const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  day: z.number().int().min(1).max(31).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

const createTaskSchema = z.object({
  groupId: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  type: z.enum(['single', 'multi', 'recurring']),
  globalDeadline: z.string().datetime({ offset: true }).optional(),
  recurrenceRule: recurrenceSchema.optional(),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).optional(),
        deadline: z.string().datetime({ offset: true }).optional(),
        assignees: z.array(z.string().min(1)).min(1).max(50),
      }),
    )
    .min(1)
    .max(30),
});

const patchTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    globalDeadline: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.title !== undefined || v.globalDeadline !== undefined, {
    message: 'nothing to update',
  });

// Item-deadline edit: an explicit null clears the item's own deadline so it
// falls back to the task-level deadline (same semantics as create).
const itemDeadlineSchema = z.object({
  deadline: z.string().datetime({ offset: true }).nullable(),
});

// A done-note is optional and short; an empty/blank string clears it.
const doneSchema = z.object({ note: z.string().trim().max(500).optional() });
const noteSchema = z.object({ note: z.string().trim().max(500) });
const assigneesSchema = z.object({ lineUids: z.array(z.string().min(1)).min(1).max(50) });
const linkSchema = z.object({
  url: z.string().trim().url().max(2000),
  label: z.string().trim().max(100).optional(),
});

/** Guard: only http(s) links (no javascript:/data: etc.). z.url() alone would
 * pass those schemes. */
function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const MAX_LINKS_PER_TASK = 20;

function canView(task: TaskWithDetails, lineUid: string, isMember: boolean): boolean {
  return (
    isMember ||
    task.created_by_line_uid === lineUid ||
    task.items.some((i) => i.assignees.some((a) => a.line_uid === lineUid))
  );
}

const tasksRoutes: FastifyPluginAsync = async (app) => {
  // ---- POST /tasks — create + announce + schedule reminders ----
  // Each create fires a metered LINE push (announcement) and schedules more
  // (reminders), so it's cost-bearing — cap it tighter than the 100/min global.
  // Keyed per-IP by @fastify/rate-limit; a per-GROUP daily cap would need the
  // parsed body (unavailable at the onRequest limiter stage), so it doesn't fit
  // this pattern — the 10/min route limit is the guard here.
  app.post('/tasks', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const body = parsed.data;
    const lineUid = request.authUser!.lineUserId;

    // Tenant guard: only members of the group can create tasks in it
    // (auto-enrolls via LINE's group-scoped profile check — no /register).
    if (!(await ensureGroupMember(app.supabase, body.groupId, lineUid))) {
      return reply.code(403).send({
        error: 'ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วลองใหม่อีกที',
        code: 'NOT_REGISTERED',
      });
    }

    // Type-shape validation beyond the schema.
    if (body.type === 'recurring') {
      if (!body.recurrenceRule) {
        return reply.code(400).send({ error: 'งานประจำต้องระบุรอบการเตือน' });
      }
      if (body.items.length !== 1) {
        return reply.code(400).send({ error: 'งานประจำต้องมีรายการเดียว' });
      }
      if (body.items[0]!.deadline) {
        // A recurring round's deadline comes ONLY from the rule — a per-item
        // deadline would spawn its own reminder round that fights the rollover.
        return reply.code(400).send({ error: 'งานประจำใช้กำหนดจากรอบเตือน ระบุ deadline รายข้อไม่ได้น้า' });
      }
    } else if (body.recurrenceRule) {
      return reply.code(400).send({ error: 'recurrenceRule ใช้ได้เฉพาะงานประจำ' });
    }
    if (body.type === 'single' && body.items.length !== 1) {
      return reply.code(400).send({ error: 'งานเดียวต้องมีรายการเดียว' });
    }

    // Deadline resolution. Recurring derives its first round from the rule;
    // others need an explicit future deadline (global or per-item).
    const now = Date.now();
    const globalDeadline =
      body.type === 'recurring'
        ? computeNextOccurrence(body.recurrenceRule!, new Date()).toISOString()
        : (body.globalDeadline ?? null);
    for (const item of body.items) {
      const eff = item.deadline ?? globalDeadline;
      if (!eff) {
        return reply.code(400).send({ error: 'ทุกข้อต้องมี deadline (ของข้อเองหรือของงาน)' });
      }
      if (new Date(eff).getTime() <= now) {
        return reply.code(400).send({ error: 'deadline ต้องอยู่ในอนาคตน้า' });
      }
    }

    // Assignees must be registered group members — their stored profile is the
    // display name/avatar snapshot the task carries (never client-supplied).
    // Dedupe per item first: a repeated uid would trip the task_assignees
    // UNIQUE(task_item_id, line_uid) constraint mid-insert and 500 the create.
    const itemAssignees = body.items.map((item) => [...new Set(item.assignees)]);
    const members = await listGroupMembers(app.supabase, body.groupId);
    const memberByUid = new Map(members.map((m) => [m.line_uid, m]));
    for (const uids of itemAssignees) {
      for (const uid of uids) {
        if (!memberByUid.has(uid)) {
          return reply.code(400).send({ error: 'มีคนที่ยังไม่ได้ลงทะเบียนในกลุ่ม เลือกใหม่อีกทีน้า' });
        }
      }
    }

    // Best-effort space link (informational): the group's shared file space.
    const { data: spaceRow } = await app.supabase
      .from('spaces')
      .select('id')
      .eq('line_group_id', body.groupId)
      .maybeSingle();

    const task = await createTaskWithItems(app.supabase, {
      spaceId: (spaceRow?.id as string | undefined) ?? null,
      groupLineId: body.groupId,
      title: body.title,
      type: body.type,
      globalDeadline,
      recurrenceRule: (body.recurrenceRule as RecurrenceRule | undefined) ?? null,
      createdByLineUid: lineUid,
      items: body.items.map((item, i) => ({
        title: item.title,
        description: item.description ?? null,
        deadline: item.deadline ?? null,
        assignees: itemAssignees[i]!.map((uid) => {
          const m = memberByUid.get(uid)!;
          return { lineUid: uid, displayName: m.display_name, pictureUrl: m.picture_url };
        }),
      })),
    });

    await scheduleReminders(app.supabase, task);

    // Announce into the group (push — LIFF submits have no replyToken). The
    // task exists and is scheduled either way; a failed push is logged loudly
    // (quota exhaustion is this API's silent-failure trap) but not fatal.
    let announced = true;
    try {
      await pushMessage(task.group_line_id, [buildTaskCreatedFlex(task)]);
    } catch (err) {
      announced = false;
      app.log.error({ err, taskId: task.id }, 'task announcement push failed');
    }

    // Analytics: task successfully created (funnel bottom for task_create_start).
    void logEvent(app.supabase, {
      eventType: 'task_create_submit',
      userId: request.authUser!.userId,
      spaceId: (spaceRow?.id as string | undefined) ?? null,
      source: 'web',
      metadata: {
        task_type: body.type,
        assignee_count: new Set(itemAssignees.flat()).size,
        has_deadline: globalDeadline != null || body.items.some((i) => i.deadline != null),
      },
    });

    const dto: TaskDto = toTaskDto(task);
    return reply.code(201).send({ task: dto, announced });
  });

  // ---- GET /tasks/mine — every task the caller created or is assigned to ----
  // User-scoped (across all their groups), for the web dashboard "งานของฉัน"
  // view. Static path — Fastify matches it before the `/tasks/:id` param route.
  app.get('/tasks/mine', { preHandler: app.authenticate }, async (request) => {
    const lineUid = request.authUser!.lineUserId;
    const tasks = await listTasksForUser(app.supabase, lineUid);
    return { tasks: tasks.map(toTaskDto), viewerLineUid: lineUid };
  });

  // ---- GET /tasks/:id — detail (group member / creator / assignee only) ----
  app.get<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid task id' });
      const task = await getTaskWithDetails(app.supabase, parsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      const lineUid = request.authUser!.lineUserId;
      // READ-ONLY membership check — must NOT enroll the caller. A task UUID is a
      // semi-public capability (it's the unauthenticated ICS export handle, so it
      // leaks into browser history/logs); auto-enrolling here would silently
      // upgrade whoever holds a task id into a full group member. Enrollment stays
      // on the explicit register/create paths only. Creators/assignees still pass
      // via canView even when not (yet) on the roster.
      const member = await isGroupMember(app.supabase, task.group_line_id, lineUid);
      if (!canView(task, lineUid, member)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      return { task: toTaskDto(task), viewerLineUid: lineUid };
    },
  );

  // ---- PATCH /tasks/:id — creator edits title/deadline (reschedules) ----
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      if (!idParsed.success) return reply.code(400).send({ error: 'Invalid task id' });
      const parsed = patchTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const lineUid = request.authUser!.lineUserId;
      if (task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'เฉพาะคนสร้างงานเท่านั้นที่แก้ไขได้น้า' });
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้จบไปแล้ว แก้ไขไม่ได้น้า' });
      }
      if (task.type === 'recurring' && parsed.data.globalDeadline) {
        return reply.code(400).send({ error: 'งานประจำเลื่อนรอบเองตามกำหนด แก้ deadline ไม่ได้น้า' });
      }
      if (
        parsed.data.globalDeadline &&
        new Date(parsed.data.globalDeadline).getTime() <= Date.now()
      ) {
        return reply.code(400).send({ error: 'deadline ต้องอยู่ในอนาคตน้า' });
      }

      const previousDeadline = task.global_deadline;
      await updateTask(app.supabase, task.id, {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.globalDeadline !== undefined
          ? { global_deadline: parsed.data.globalDeadline }
          : {}),
      });

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      if (parsed.data.globalDeadline !== undefined) {
        await rescheduleReminders(app.supabase, updated, previousDeadline);
      }
      return { task: toTaskDto(updated) };
    },
  );

  // ---- PATCH /tasks/:id/items/:itemId — creator edits one item's own deadline ----
  // Fills the gap where a mis-set per-item deadline was only fixable by
  // cancel + recreate (which pushes a "ยกเลิกงาน" notice to the whole group).
  // Reminder rounds are rebuilt via rescheduleReminders, whose
  // TASK_NOTIFICATIONS_ENABLED gate stays authoritative (no rows/jobs are
  // created while the reminder push is soft-disabled).
  app.patch<{ Params: { id: string; itemId: string } }>(
    '/tasks/:id/items/:itemId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      const itemParsed = z.string().uuid().safeParse(request.params.itemId);
      if (!idParsed.success || !itemParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = itemDeadlineSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const lineUid = request.authUser!.lineUserId;
      if (task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'เฉพาะคนสร้างงานเท่านั้นที่แก้ไขได้น้า' });
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้จบไปแล้ว แก้ไขไม่ได้น้า' });
      }
      if (task.type === 'recurring') {
        // Same rule as create: a recurring round's deadline comes ONLY from
        // the rule — a per-item deadline would fight the rollover.
        return reply.code(400).send({ error: 'งานประจำใช้กำหนดจากรอบเตือน ระบุ deadline รายข้อไม่ได้น้า' });
      }
      const item = task.items.find((i) => i.id === itemParsed.data);
      if (!item) return reply.code(404).send({ error: 'Task item not found' });
      if (item.status === 'done' || item.status === 'cancelled') {
        return reply.code(409).send({ error: 'ข้อนี้จบไปแล้ว แก้ไขไม่ได้น้า' });
      }
      if (parsed.data.deadline === null && !task.global_deadline) {
        // Mirrors the create-time rule: every item needs SOME effective deadline.
        return reply.code(400).send({ error: 'ทุกข้อต้องมี deadline (ของข้อเองหรือของงาน)' });
      }
      if (parsed.data.deadline && new Date(parsed.data.deadline).getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'deadline ต้องอยู่ในอนาคตน้า' });
      }

      const { error: updateErr } = await app.supabase
        .from('task_items')
        .update({ deadline: parsed.data.deadline })
        .eq('id', item.id);
      if (updateErr) throw updateErr;

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      // Rebuild all rounds from the task's CURRENT deadlines (cancel +
      // schedule): scheduleReminders re-derives per-item vs shared task-level
      // rounds itself, so moving an item off/onto the global deadline lands in
      // the right round shape.
      await rescheduleReminders(app.supabase, updated);
      return { task: toTaskDto(updated) };
    },
  );

  // ---- POST /tasks/:id/items/:itemId/done — assignee marks own part done ----
  app.post<{ Params: { id: string; itemId: string } }>(
    '/tasks/:id/items/:itemId/done',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      const itemParsed = z.string().uuid().safeParse(request.params.itemId);
      if (!idParsed.success || !itemParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }

      const parsedBody = doneSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({ error: 'Invalid body', issues: parsedBody.error.issues });
      }
      const note = parsedBody.data.note ? parsedBody.data.note : null;

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      if (task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้ถูกยกเลิกไปแล้วน้า' });
      }
      const item = task.items.find((i) => i.id === itemParsed.data);
      if (!item) return reply.code(404).send({ error: 'Task item not found' });

      const lineUid = request.authUser!.lineUserId;
      const marked = await markAssigneeDone(app.supabase, item.id, lineUid, note);
      if (!marked) {
        return reply.code(403).send({ error: 'ข้อนี้ไม่ได้มอบหมายให้เราน้า' });
      }

      const { taskDone } = await rollUpCompletion(app.supabase, task.id);
      if (taskDone) {
        await cancelReminders(app.supabase, task);
      }

      // Analytics: assignee completed their part. time_to_complete = seconds from
      // task creation to this done mark (structured number, no PII).
      const createdMs = new Date(task.created_at).getTime();
      void logEvent(app.supabase, {
        eventType: 'task_mark_done',
        userId: request.authUser!.userId,
        spaceId: task.space_id,
        source: 'web',
        metadata: {
          task_type: task.type,
          ...(Number.isFinite(createdMs)
            ? { time_to_complete: Math.max(0, Math.round((Date.now() - createdMs) / 1000)) }
            : {}),
        },
      });

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated), taskDone };
    },
  );

  // ---- DELETE /tasks/:id — creator cancels the task (withdraws reminders) ----
  app.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      if (!idParsed.success) return reply.code(400).send({ error: 'Invalid task id' });

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const lineUid = request.authUser!.lineUserId;
      if (task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'เฉพาะคนสร้างงานเท่านั้นที่ยกเลิกได้น้า' });
      }
      if (task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้ถูกยกเลิกไปแล้วน้า' });
      }
      if (task.status === 'done') {
        return reply.code(409).send({ error: 'งานนี้เสร็จไปแล้ว ยกเลิกไม่ได้น้า' });
      }

      await cancelTask(app.supabase, task.id);
      // Withdraw outstanding reminders + the recurring rollover job.
      await cancelReminders(app.supabase, task);

      // Notify the group (push — same sanctioned exception as the announcement).
      // Best-effort: the cancel already committed; a failed push is logged only.
      try {
        await pushMessage(task.group_line_id, [
          { type: 'text', text: `ยกเลิกงาน "${task.title}" แล้วน้า ไม่ต้องทำต่อแล้ว` },
        ]);
      } catch (err) {
        app.log.error({ err, taskId: task.id }, 'task cancel push failed');
      }

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated) };
    },
  );

  // ---- PUT /tasks/:id/items/:itemId/assignees — creator edits who owes an item ----
  app.put<{ Params: { id: string; itemId: string } }>(
    '/tasks/:id/items/:itemId/assignees',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      const itemParsed = z.string().uuid().safeParse(request.params.itemId);
      if (!idParsed.success || !itemParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = assigneesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const lineUid = request.authUser!.lineUserId;
      if (task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'เฉพาะคนสร้างงานเท่านั้นที่แก้ผู้รับผิดชอบได้น้า' });
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้จบไปแล้ว แก้ไขไม่ได้น้า' });
      }
      const item = task.items.find((i) => i.id === itemParsed.data);
      if (!item) return reply.code(404).send({ error: 'Task item not found' });

      // Dedupe + validate every uid is a registered member of the task's group.
      const wantedUids = [...new Set(parsed.data.lineUids)];
      const members = await listGroupMembers(app.supabase, task.group_line_id);
      const memberByUid = new Map(members.map((m) => [m.line_uid, m]));
      for (const uid of wantedUids) {
        if (!memberByUid.has(uid)) {
          return reply.code(400).send({ error: 'มีคนที่ยังไม่ได้ลงทะเบียนในกลุ่ม เลือกใหม่อีกทีน้า' });
        }
      }

      await replaceItemAssignees(
        app.supabase,
        item.id,
        wantedUids.map((uid) => {
          const m = memberByUid.get(uid)!;
          return { lineUid: uid, displayName: m.display_name, pictureUrl: m.picture_url };
        }),
      );

      // Removing a pending assignee can complete an item (and the task).
      const { taskDone } = await rollUpCompletion(app.supabase, task.id);
      if (taskDone) await cancelReminders(app.supabase, task);

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated), taskDone };
    },
  );

  // ---- POST /tasks/:id/items/:itemId/accept — assignee acknowledges (optional) ----
  app.post<{ Params: { id: string; itemId: string } }>(
    '/tasks/:id/items/:itemId/accept',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      const itemParsed = z.string().uuid().safeParse(request.params.itemId);
      if (!idParsed.success || !itemParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      if (task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้ถูกยกเลิกไปแล้วน้า' });
      }
      const item = task.items.find((i) => i.id === itemParsed.data);
      if (!item) return reply.code(404).send({ error: 'Task item not found' });

      const lineUid = request.authUser!.lineUserId;
      const isAssignee = item.assignees.some((a) => a.line_uid === lineUid);
      if (!isAssignee) {
        return reply.code(403).send({ error: 'ข้อนี้ไม่ได้มอบหมายให้เราน้า' });
      }
      await markAssigneeAccepted(app.supabase, item.id, lineUid); // idempotent

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated) };
    },
  );

  // ---- PATCH /tasks/:id/items/:itemId/note — assignee edits their done note ----
  app.patch<{ Params: { id: string; itemId: string } }>(
    '/tasks/:id/items/:itemId/note',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      const itemParsed = z.string().uuid().safeParse(request.params.itemId);
      if (!idParsed.success || !itemParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = noteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const item = task.items.find((i) => i.id === itemParsed.data);
      if (!item) return reply.code(404).send({ error: 'Task item not found' });

      const lineUid = request.authUser!.lineUserId;
      // Empty string clears the note (stored as NULL).
      const note = parsed.data.note.length > 0 ? parsed.data.note : null;
      const ok = await setDoneNote(app.supabase, item.id, lineUid, note);
      if (!ok) return reply.code(403).send({ error: 'ข้อนี้ไม่ได้มอบหมายให้เราน้า' });

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated) };
    },
  );

  // ---- POST /tasks/:id/links — creator attaches a reference link ----
  app.post<{ Params: { id: string } }>(
    '/tasks/:id/links',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      if (!idParsed.success) return reply.code(400).send({ error: 'Invalid task id' });
      const parsed = linkSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
      }
      if (!isHttpUrl(parsed.data.url)) {
        return reply.code(400).send({ error: 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https:// น้า' });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const lineUid = request.authUser!.lineUserId;
      if (task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'เฉพาะคนสร้างงานเท่านั้นที่แนบลิงก์ได้น้า' });
      }
      if (task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้ถูกยกเลิกไปแล้วน้า' });
      }
      if (task.links.length >= MAX_LINKS_PER_TASK) {
        return reply.code(409).send({ error: `แนบลิงก์ได้สูงสุด ${MAX_LINKS_PER_TASK} ลิงก์ต่องานน้า` });
      }

      await addTaskLink(
        app.supabase,
        task.id,
        parsed.data.url,
        parsed.data.label ? parsed.data.label : null,
        lineUid,
      );
      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return reply.code(201).send({ task: toTaskDto(updated) });
    },
  );

  // ---- DELETE /tasks/:id/links/:linkId — creator removes a link ----
  app.delete<{ Params: { id: string; linkId: string } }>(
    '/tasks/:id/links/:linkId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.id);
      const linkParsed = z.string().uuid().safeParse(request.params.linkId);
      if (!idParsed.success || !linkParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const lineUid = request.authUser!.lineUserId;
      if (task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'เฉพาะคนสร้างงานเท่านั้นที่ลบลิงก์ได้น้า' });
      }

      const removed = await deleteTaskLink(app.supabase, task.id, linkParsed.data);
      if (!removed) return reply.code(404).send({ error: 'Link not found' });

      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated) };
    },
  );

  // ---- GET /tasks/:id/ics — calendar export (no OAuth, works everywhere) ----
  // UNAUTHENTICATED by design: the button in the LINE Flex card opens this in
  // an external browser with no session cookie. The unguessable task UUID is
  // the capability (same trust model as share links / box slugs), with its own
  // per-IP rate limit + noindex/no-store so links can't be crawled or cached.
  app.get<{ Params: { id: string } }>(
    '/tasks/:id/ics',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid task id' });
      const task = await getTaskWithDetails(app.supabase, parsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      const cal = ical({ name: 'หนูเก็บ — งานของฉัน', prodId: '//nookeb//tasks//TH' });

      const addAlarms = (event: ReturnType<typeof cal.createEvent>) => {
        // -1440 นาที and -180 นาที before the event (triggers are seconds-before).
        event.createAlarm({ type: ICalAlarmType.display, trigger: 1440 * 60 });
        event.createAlarm({ type: ICalAlarmType.display, trigger: 180 * 60 });
      };

      if (task.type === 'recurring' && task.recurrence_rule && task.global_deadline) {
        // DTSTART is the next occurrence (a UTC instant); the RRULE repeats
        // from it. Thailand has no DST, so the fixed +7 offset keeps every
        // occurrence at the same Bangkok wall-clock time.
        const freqMap: Record<RecurrenceRule['freq'], ICalEventRepeatingFreq> = {
          daily: ICalEventRepeatingFreq.DAILY,
          weekly: ICalEventRepeatingFreq.WEEKLY,
          monthly: ICalEventRepeatingFreq.MONTHLY,
        };
        const start = new Date(task.global_deadline);
        const event = cal.createEvent({
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          summary: task.title,
          description: task.items[0]?.description ?? undefined,
          repeating: { freq: freqMap[task.recurrence_rule.freq] },
        });
        addAlarms(event);
      } else {
        for (const item of task.items) {
          const deadline = effectiveDeadline(task, item);
          if (!deadline) continue;
          const start = new Date(deadline);
          const event = cal.createEvent({
            start,
            end: new Date(start.getTime() + 30 * 60_000),
            summary: task.type === 'single' ? task.title : `${task.title} — ${item.title}`,
            description: item.description ?? undefined,
          });
          addAlarms(event);
        }
      }

      reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="nookeb-task.ics"')
        .header('X-Robots-Tag', 'noindex, nofollow')
        .header('Cache-Control', 'no-store');
      return reply.send(cal.toString());
    },
  );
};

export default tasksRoutes;
