# Microsoft Teams connector: implementation guide

**Status: not implemented. The connector is disabled.** MeetMind works without Teams. `src/server/providers/calling/teams.ts` is a stub: every operation fails with `NOT_CONFIGURED`, and every capability flag is `false`. The admin Integrations panel reports the connector as disabled. Nothing in the app pretends Teams works.

This guide lists what's required to build the connector and where it plugs in. Microsoft changes permission names and licensing over time, so verify each permission against the current Microsoft Graph documentation before granting it.

---

## 1. What the connector would provide

| Capability | Teams mechanism | Needs a calling bot? |
|---|---|---|
| Create / schedule a Teams meeting | Graph `POST /users/{id}/events` with `isOnlineMeeting: true` (calendar plus invites), or `POST /users/{id}/onlineMeetings` (meeting only) | No |
| Join link | `onlineMeeting.joinWebUrl`. Users join in Teams; MeetMind can't mint LiveKit-style tokens for Teams | No |
| Invite participants (scheduled meeting) | Update the event's `attendees` (Exchange sends the invite) | No |
| Free/busy | `POST /users/{id}/calendar/getSchedule` | No |
| Transcript after the meeting | `GET /users/{id}/onlineMeetings/{meetingId}/transcripts` → `/{transcriptId}/content?$format=text/vtt` | No |
| Attendance after the meeting | `GET /users/{id}/onlineMeetings/{meetingId}/attendanceReports` | No |
| "Who is in the call right now", invite into a **live** call, remove or mute someone, end the call | Cloud Communications API (`/communications/calls/...`). The app must join the call as a bot | **Yes** |
| Live transcription stream | Application-hosted media bot (Windows plus the .NET media SDK) | **Yes** |

The connector should start with the no-bot column: scheduling, invites, free/busy, and transcripts after the meeting. Live-call control is a separate, larger project (§6).

## 2. Microsoft Entra ID app registration

1. **Register the app.** In the Entra admin center, go to **App registrations → New registration**.
   - Name: `MeetMind Teams Connector`.
   - Supported account types: *single tenant*, which is recommended.
   - Redirect URI (Web): `https://<your-domain>/api/integrations/microsoft/callback`. This is only needed for delegated sign-in (§2.3).
2. **Create a credential.** Under **Certificates & secrets**, create a client secret or, preferably, upload a certificate. Record:
   - `MS_TENANT_ID` (Directory/tenant ID)
   - `MS_CLIENT_ID` (Application/client ID)
   - `MS_CLIENT_SECRET`, or the certificate path and thumbprint
3. **Add API permissions.** Under **API permissions → Microsoft Graph**, choose **Application** permissions for server-to-server use and grant **admin consent**:

| Permission | Used for |
|---|---|
| `User.Read.All` | Map MeetMind users to Entra object IDs by verified email/UPN |
| `Calendars.ReadWrite` | Create and update Teams-enabled calendar events, attendees and cancellations |
| `Calendars.Read` | `getSchedule` free/busy (Calendars.ReadWrite also covers it) |
| `OnlineMeetings.ReadWrite.All` | Create and read online meetings, and look up a meeting by `joinWebUrl` |
| `OnlineMeetingTranscript.Read.All` | List and download meeting transcripts |
| `OnlineMeetingArtifact.Read.All` | Attendance reports |
| `OnlineMeetingRecording.Read.All` | *(optional)* Recordings, if you transcribe them yourself |

**Least privilege.** Application permissions apply tenant-wide. Restrict them:
- **Mailbox access:** create an Exchange **application access policy** (or the newer RBAC for Applications) limiting the app to the mailboxes of MeetMind users.
- **Meeting access:** create a Teams **application access policy** (step 4); without it the online-meeting endpoints return 403.

4. **Teams application access policy.** This is required for the app-only `onlineMeetings` and transcript APIs. Run it in the MicrosoftTeams PowerShell module as a Teams admin:

```powershell
Connect-MicrosoftTeams
New-CsApplicationAccessPolicy -Identity MeetMind-Policy -AppIds "<MS_CLIENT_ID>" -Description "MeetMind connector"
# Either specific organisers…
Grant-CsApplicationAccessPolicy -PolicyName MeetMind-Policy -Identity "organiser@contoso.com"
# …or the whole tenant:
Grant-CsApplicationAccessPolicy -PolicyName MeetMind-Policy -Global
```

The policy can take up to about 30 minutes to take effect.

### 2.3 Delegated alternative (per-user consent)

If tenant-wide application permissions aren't acceptable, use delegated permissions instead:
- Permissions: `OnlineMeetings.ReadWrite`, `Calendars.ReadWrite`, `OnlineMeetingTranscript.Read.All`, `offline_access`.
- Each user connects their account once (OAuth authorization-code flow with PKCE).
- Store their refresh token encrypted in `IntegrationConnection` (§4).

Actions then happen strictly as that user.

### 2.4 Licensing and tenant prerequisites

- **Transcripts:** they're only available when transcription was turned on *in Teams* for that meeting.
- **Policies and licences:** tenant meeting policies must allow transcription, and some APIs need specific Teams/Microsoft 365 licences. Check the current Microsoft docs for your tenant.
- **Change notifications:** these need a publicly reachable HTTPS endpoint and subscription renewal, roughly every 1 to 3 days.

## 3. Configuration

```bash
MS_TENANT_ID=<directory id>
MS_CLIENT_ID=<application id>
MS_CLIENT_SECRET=<secret>        # or certificate settings
```

At startup the connector should do three things:
- Copy these into an `IntegrationConnection` row (`provider = MICROSOFT_TEAMS`, `status = ACTIVE`, `encryptedCredentials = encryptJson({...})`), using `src/server/crypto.ts`, which is AES-256-GCM keyed by `ENCRYPTION_KEY`.
- Read from that row afterwards, so secrets aren't held in many places.
- Flip the capability flags in `getIntegrationStatus` (`src/server/services/integrations.ts`) once a token request succeeds.

## 4. How it fits the existing abstractions

**Calling provider** (`src/server/providers/calling/types.ts`). Implement `createTeamsProvider()` against Graph:

| Method | Teams implementation (no bot) |
|---|---|
| `capabilities` | `issueJoinCredentials: false`, `listParticipants: false`, `removeParticipant: false`, `muteParticipant: false`, `endMeeting: false`, `nativeTranscription: true`, `recording: true` |
| `ensureRoom` | Create the online meeting or Teams calendar event. Return the Graph `onlineMeeting.id` as `roomId` |
| `issueJoinCredentials` | Not supported. The UI shows `joinWebUrl` ("Open in Teams") instead of the LiveKit lobby |
| `listParticipants` / `removeParticipant` / `muteParticipantAudio` / `endRoom` | Throw `NOT_CONFIGURED` with a clear message unless the bot (§6) exists |
| `parseWebhook` | Validate Graph change notifications (validation token handshake, `clientState`), then map transcript-available notifications to an event |

**Identifiers.** Never reuse LiveKit identifiers for Teams.

| MeetMind | Teams |
|---|---|
| `Meeting.provider` | `MICROSOFT_TEAMS` |
| `Meeting.providerRoomId` | Graph `onlineMeeting.id` (unique per provider via `@@unique([provider, providerRoomId])`) |
| `Meeting.providerMetadata` | `{ joinWebUrl, organizerObjectId, calendarEventId, iCalUId, chatThreadId }` |
| `User` | Entra object ID. Store per user via `IntegrationConnection.externalAccountId` (or a dedicated external-identity table), matched on **verified** email/UPN, never on display name |

**Meeting service.** Branch on `meeting.provider` in `joinMeeting`, which already refuses non-LiveKit meetings with a clear message. In-call host controls should check `provider.capabilities` before showing buttons, so unsupported actions never appear.

**Calendar.** Add a `CalendarProvider` interface beside the internal calendar, so `findConflicts` / `getAvailability` can merge internal busy blocks with Teams/Outlook ones. Use the existing `CalendarEvent.provider = OUTLOOK` and `externalEventId` fields when mirroring events. Keep the "external calendars not connected" notes in the UI and assistant until it exists.

**Transcripts.** Add a `TranscriptionJob` with `source = PROVIDER_NATIVE` that does the following:
1. Download the VTT (`/transcripts/{id}/content?$format=text/vtt`).
2. Parse it with the existing `parseTranscriptFile` (`src/server/transcript-import.ts`). That parser already understands Teams-style `<v Speaker>` voice tags.
3. Map speakers to users only on an unambiguous match (the same rule as imports).
4. Store segments.

The existing indexing, summaries and RAG pipeline then work unchanged. Use the job idempotency key `teams:<onlineMeetingId>:<transcriptId>`.

**AI agent.** No changes. Tools call the meeting services; capability checks surface as tool errors ("not supported for Teams meetings"), which the assistant relays.

## 5. Implementation checklist

1. Write a token client using the client-credentials flow (`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`). Cache tokens until expiry and retry 429s with `Retry-After`.
2. Map users: match each MeetMind user to an Entra object ID by verified email. Never guess between multiple matches.
3. Implement `ensureRoom` / scheduling through calendar events, and store `providerMetadata`.
4. In the UI, show "Open in Teams" (`joinWebUrl`) for Teams meetings and hide unsupported in-call controls.
5. Ingest transcripts after the meeting, via change-notification subscription plus a polling fallback.
6. Add tests: mock Graph responses in unit and integration tests, and run one manual end-to-end check against a dev tenant before enabling.
7. Update the Integrations panel and docs.

## 6. Optional: real-time features (calling bot)

These need a Teams calling bot: live participant lists, inviting people into an in-progress call, removing or muting someone, and live transcription. That involves:
- an Azure Bot resource;
- a Teams app manifest with `supportsCalling` and `supportsVideo`;
- application permissions such as `Calls.JoinGroupCall.All`, `Calls.InitiateGroupCall.All`, `Calls.AccessMedia.All`;
- a public HTTPS callback.

For audio access, an application-hosted media service is needed, which currently means Windows Server and the .NET real-time media SDK. Treat it as a separate service implementing the bot-dependent `CallingProvider` methods.
