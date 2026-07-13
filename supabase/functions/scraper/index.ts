import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { buildMarkdownList, isWithinTimeWindow, randomDelay } from "./utils.ts";
import { getDynamicHeaders, getValidToken } from "./padelApi.ts";

// Fetch environment secrets
const MATCHES_URL = Deno.env.get("PADEL_MATCHES_URL") ?? "";
const NTFY_CHANNEL = Deno.env.get("PADEL_NTFY_CHANNEL") ?? "";

export default {
  fetch: withSupabase({ auth: "secret:new_secret" }, async (req, ctx) => {
    const supabase = ctx.supabaseAdmin;

    try {
      const accessToken = await getValidToken(supabase);
      const extraHeaders = await getDynamicHeaders(supabase);

      const { data: existingDbSlots } = await supabase
        .from("notified_slots")
        .select("court_id, slot_time, duration_seconds")
        .gte("slot_time", new Date().toISOString());

      const dbSlotsSet = new Set(
        (existingDbSlots || []).map((row) =>
          `${row.court_id}|${row.slot_time}|${row.duration_seconds}`
        ),
      );

      const activeApiSlots = new Set<string>();
      const newRowsToInsert: any[] = [];
      const parsedSlots = new Map<string, {
        courtName: string;
        dateObj: Date;
        dateStr: string;
        timeStr: string;
        durations: number[];
        isNew: boolean;
      }>();
      const payloads = [];

      const today = new Date();
      const TOTAL_DAYS = 21;
      const BATCH_SIZE = 3;

      // === SMART BATCHING ===
      // Die äußere Schleife springt in 3er-Schritten (0, 3, 6, 9...)
      for (let i = 0; i < TOTAL_DAYS; i += BATCH_SIZE) {
        // Baut ein Array mit den zu scannenden Tagen für diesen speziellen Batch
        // z.B. [0, 1, 2] im ersten Durchlauf, [3, 4, 5] im zweiten.
        const currentBatch = Array.from(
          { length: Math.min(BATCH_SIZE, TOTAL_DAYS - i) },
          (_, idx) => i + idx,
        );

        console.log(`Starte Batch für die Offsets: ${currentBatch.join(", ")}`);

        // Wir feuern alle Requests dieses Batches GLEICHZEITIG ab
        const fetchPromises = currentBatch.map(async (dayOffset) => {
          const fetchDate = new Date();
          fetchDate.setDate(today.getDate() + dayOffset);
          const dateStr = fetchDate.toISOString().split("T")[0];

          const targetUrl = new URL(MATCHES_URL);
          // Setze den Startpunkt auf 00:00 Uhr des jeweiligen Tages (wie von dir spezifiziert)
          targetUrl.searchParams.set(
            "earliestStartTime",
            `${dateStr}T00:00:00.000Z`,
          );
          targetUrl.searchParams.set("sportType", "PADEL");
          targetUrl.searchParams.set("isCoachAvailable", "false");
          targetUrl.searchParams.set("kind", "PRIVATE");

          const response = await fetch(targetUrl.toString(), {
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              ...extraHeaders,
            },
          });

          if (!response.ok) {
            console.error(
              `Fetch failed for day ${dateStr}: ${response.status}`,
            );
            return null; // Wenn ein Tag fehlschlägt, geben wir null zurück, anstatt alles crashen zu lassen
          }
          return response.json();
        });

        // Warten, bis ALLE 3 Requests aus diesem Batch beantwortet wurden
        const batchResults = await Promise.all(fetchPromises);

        // Verarbeiten der gesammelten Antworten dieses Batches
        for (const payload of batchResults) {
          if (!payload) continue; // Überspringt fehlgeschlagene Requests
          payloads.push(payload);

          const startingTimes = payload.startingTimes || [];
          for (const timeBlock of startingTimes) {
            const matchStartsAt = timeBlock.matchStartsAt;

            if (!isWithinTimeWindow(matchStartsAt)) continue;

            for (const court of timeBlock.availableCourts || []) {
              for (const slot of court.availableMatchSlots || []) {
                const durationSeconds = slot.period?.durationInSeconds || 0;
                const slotKey =
                  `${court.id}|${matchStartsAt}|${durationSeconds}`;
                activeApiSlots.add(slotKey);

                const isNew = !dbSlotsSet.has(slotKey);
                if (isNew) {
                  newRowsToInsert.push({
                    court_id: court.id,
                    slot_time: matchStartsAt,
                    duration_seconds: durationSeconds,
                  });
                }

                // Gruppierung für die verschachtelte Benachrichtigung
                const groupKey = `${court.id}|${matchStartsAt}`;
                if (!parsedSlots.has(groupKey)) {
                  const dateObj = new Date(matchStartsAt);
                  parsedSlots.set(groupKey, {
                    courtName: court.name,
                    dateObj: dateObj,
                    // Sofort zeitzonensicher formatieren
                    dateStr: dateObj.toLocaleDateString("de-DE", {
                      timeZone: "Europe/Berlin",
                      day: "2-digit",
                      month: "2-digit",
                    }),
                    timeStr: dateObj.toLocaleTimeString("de-DE", {
                      timeZone: "Europe/Berlin",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                    durations: [],
                    isNew: false,
                  });
                }

                const entry = parsedSlots.get(groupKey)!;
                entry.durations.push(durationSeconds / 60);
                // Wenn auch nur eine Dauer (z.B. 90 Min) für diese Uhrzeit neu ist, markieren wir den ganzen Block als NEW
                if (isNew) entry.isNew = true;
              }
            }
          }
        }

        // Führe den Delay aus, AUßER nach dem allerletzten Batch
        if (i + BATCH_SIZE < TOTAL_DAYS) {
          await randomDelay();
        }
      }
      // === ENDE SMART BATCHING ===

      // State Reconciliation (Unverändert)
      const rowsToDelete = (existingDbSlots || []).filter((dbRow) => {
        const dbSlotKey =
          `${dbRow.court_id}|${dbRow.slot_time}|${dbRow.duration_seconds}`;
        return !activeApiSlots.has(dbSlotKey);
      });

      if (rowsToDelete.length > 0) {
        await Promise.all(rowsToDelete.map((row) =>
          supabase
            .from("notified_slots")
            .delete()
            .match({
              court_id: row.court_id,
              slot_time: row.slot_time,
              duration_seconds: row.duration_seconds,
            })
        ));
      }

      // Benachrichtigung & Insert (Unverändert)
      // === NOTIFICATION BUILDER ===
      const newEntries = Array.from(parsedSlots.values()).filter((e) =>
        e.isNew
      );
      const existingEntries = Array.from(parsedSlots.values()).filter((e) =>
        !e.isNew
      );

      let messageBody = "";
      if (newEntries.length > 0) {
        messageBody += "**NEW**\n" + buildMarkdownList(newEntries) + "\n\n";
      }
      if (existingEntries.length > 0) {
        messageBody += "**Still Open**\n" + buildMarkdownList(existingEntries);
      }
      messageBody = messageBody.trim();

      if (newEntries.length > 0) {
        await fetch(`https://ntfy.sh/${NTFY_CHANNEL}`, {
          method: "POST",
          headers: {
            "Title": "Padel Updates Found!",
            "Tags": "padel",
            "Markdown": "yes",
          },
          body: messageBody,
        });

        // Wir schreiben nur in die DB, wenn wir auch wirklich benachrichtigt haben
        await supabase.from("notified_slots").insert(newRowsToInsert);
      }

      return Response.json({
        status: "success",
        new_slot_durations_found: newRowsToInsert.length,
        slots_removed: rowsToDelete.length,
      });
    } catch (err) {
      console.error(err);
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }),
};
