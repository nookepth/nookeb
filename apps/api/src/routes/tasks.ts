import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import ical, { ICalAlarmType, ICalEventRepeatingFreq } from 'ical-generator';
import type { RecurrenceRule, TaskDto } from '@nookeb/shared';
import { pushMessage } from '../services/line.service';
import { buildTaskCreatedFlex } from '../services/lineMessage';
import {
  createTaskWithItems,
  effectiveDeadline,
  getTaskWithDetails,
  ensureGroupMember,
  listGroupMembers,
  listTasksForUser,
  markAssigneeDone,
  rollUpCompletion,
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

function canView(task: TaskWithDetails, lineUid: string, isMember: boolean): boolean {
  return (
    isMember ||
    task.created_by_line_uid === lineUid ||
    task.items.some((i) => i.assignees.some((a) => a.line_uid === lineUid))
  );
}

const tasksRoutes: FastifyPluginAsync = async (app) => {
  // ---- POST /tasks — create + announce + schedule reminders ----
  app.post('/tasks', { preHandler: app.authenticate }, async (request, reply) => {
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
      const member = await ensureGroupMember(app.supabase, task.group_line_id, lineUid);
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

      const task = await getTaskWithDetails(app.supabase, idParsed.data);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const item = task.items.find((i) => i.id === itemParsed.data);
      if (!item) return reply.code(404).send({ error: 'Task item not found' });

      const lineUid = request.authUser!.lineUserId;
      const marked = await markAssigneeDone(app.supabase, item.id, lineUid);
      if (!marked) {
        return reply.code(403).send({ error: 'ข้อนี้ไม่ได้มอบหมายให้เราน้า' });
      }

      const { taskDone } = await rollUpCompletion(app.supabase, task.id);
      if (taskDone) {
        await cancelReminders(app.supabase, task);
      }
      const updated = (await getTaskWithDetails(app.supabase, task.id))!;
      return { task: toTaskDto(updated), taskDone };
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
