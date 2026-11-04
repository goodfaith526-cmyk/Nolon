# 09c: approving bot requests, client feedback of 2026-11-04

NOLON's staff reviewed the bot booking flow on staging (BR-000014, from the website chat, Dubai to
Khartoum) and asked for four things. This note records what this PR does with each one and why.

## 1. "Not saved: The booking's customer is not of the request's branch"

**Cause.** A website-chat request is linked to no customer and no profile, so staff chose the
customer with the general customer search. That search lists every branch's customers, and a
customer of another branch fails the approval's rule: a booking and its customer belong to the
same branch.

**Change.** The tie between a customer and a branch is removed entirely (owner, 2026-11-04). See
plan [09d](09d-customer-not-tied-to-branch.md), which replaces 09b. This PR carries that plan,
and its build steps (09-7a..c) follow its review.

## 2. "Register the customer directly"

**Change.** `POST /cs-booking-requests/:id/approve` accepts `newCustomerFromRequest: true` for a
request linked to no customer or profile. In the approval's transaction, NOLON creates the booking's
customer in the request's branch:

- an individual;
- name = the request's sender name;
- phone = the contact phone the bot sent;
- the ordinary create checks apply, including the branch's phone/tax uniqueness lock;
- `createdById` = the approving staff member, `createdViaApiClientId` = the bot's key.

On the form, this is the default for such a request ("new customer from the request: name and
phone"). Staff can switch to choosing an existing customer of the branch instead.

⭐ **Never matched by phone or name.** A phone that another customer of the branch already has is a 409. Staff then choose that customer. The phone comes from the chat and is unverified, so matching
on it could book someone else's account.

**Refusals.**

| Case                                                             | Answer                          |
| ---------------------------------------------------------------- | ------------------------------- |
| Request already linked to a customer or profile                  | 400 `NEW_CUSTOMER_NOT_ALLOWED`  |
| `newCustomerFromRequest` sent together with `booking.customerId` | 400 `NEW_CUSTOMER_NOT_ALLOWED`  |
| Staff without `customers:create` in the branch                   | 403 `CUSTOMER_CREATE_FORBIDDEN` |

Linked requests are unchanged: profile requests still get their account from the profile (instant
account or approval).

## 3. "The draft should arrive complete; staff should not enter the name, currency, details again"

The request already carries everything the form needs: route, items, currency, services and
sender. The customer is covered by item 2.

**Change.** The form now checks the price itself as it opens, when the route, currency and lines
are complete. Staff only confirm. They check again only after changing an input. The API checks
the price again under the rate card's lock, as before.

## 4. "The first serial should continue from the provisional booking to the shipment, for tracking"

**Not in this PR.** It touches numbering decisions (#111, #115, #128) and the shipment number
formats the agent's tracking reads.

⭐ **Proposed next step.** Booking and shipment keep their own numbers, and every place that tracks
also accepts the request's number:

- the public tracking page;
- the bot's tracking lookup.

The booking and shipment screens also show "bot request BR-…". The customer keeps the one number
they were given from the first message to delivery, and nothing renumbers. This will be its own
small PR after this one.

## Agent impact

None. The approve route is staff-only, and no route the agent calls changes.

Requests made through the signed profile (`--profile-booking on` on the agent side) still get their
account automatically when they are saved. See
/mnt/project-files/nolon/agent-notes/profile-booking-for-agent-project-2026-11-04.md.
