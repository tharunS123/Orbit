/**
 * Starter templates. Each is plain Markdown so it is easy to edit; tasks use "- [ ]" lines and
 * may carry natural-language dates ("every Monday", "Fri") parsed at creation time.
 */
export interface Template {
  id: string;
  title: string;
  emoji: string;
  description: string;
  category: 'personal' | 'work' | 'team';
  markdown: string;
}

export const TEMPLATES: Template[] = [
  {
    id: 'weekly-planning',
    title: 'Weekly planning',
    emoji: '🗓️',
    description: 'Review last week, set three priorities and plan each day.',
    category: 'personal',
    markdown: `## Review
- [ ] Clear Inbox every Monday
- [ ] Look back at what got done
## Priorities this week
- [ ] Priority 1
- [ ] Priority 2
- [ ] Priority 3
## Notes
What would make this week great?`,
  },
  {
    id: 'project-launch',
    title: 'Project launch',
    emoji: '🚀',
    description: 'From kickoff to launch day with owners and milestones.',
    category: 'work',
    markdown: `## Goals
Describe what success looks like and how you'll measure it.
## Kickoff
- [ ] Agree on scope and success metrics
- [ ] Assign owners for each workstream
## Build
- [ ] Design review
- [ ] Implementation complete
- [ ] QA sign-off
## Launch
- [ ] Announcement draft
- [ ] Launch checklist review
- [ ] Post-launch retro`,
  },
  {
    id: 'grocery',
    title: 'Grocery list',
    emoji: '🛒',
    description: 'A reusable shopping list grouped by aisle.',
    category: 'personal',
    markdown: `## Produce
- [ ] Apples
- [ ] Spinach
## Dairy
- [ ] Milk
- [ ] Eggs
## Pantry
- [ ] Pasta
- [ ] Olive oil`,
  },
  {
    id: 'meeting-agenda',
    title: 'Meeting agenda',
    emoji: '🤝',
    description: 'Agenda, decisions and follow-ups for a recurring meeting.',
    category: 'team',
    markdown: `## Agenda
1. Updates
2. Discussion topics
3. Decisions needed
## Decisions
> Capture decisions here as they are made.
## Follow-ups
- [ ] Share notes with attendees`,
  },
  {
    id: 'trip-planning',
    title: 'Trip planning',
    emoji: '✈️',
    description: 'Bookings, packing and the itinerary in one place.',
    category: 'personal',
    markdown: `## Bookings
- [ ] Flights
- [ ] Accommodation
- [ ] Travel insurance
## Packing
- [ ] Passport
- [ ] Chargers and adapters
## Itinerary
Day 1 —`,
  },
  {
    id: 'habit-tracker',
    title: 'Habit tracker',
    emoji: '🌱',
    description: 'Repeating tasks that build good routines.',
    category: 'personal',
    markdown: `## Daily
- [ ] Drink water every day
- [ ] Read for 20 minutes every day
## Weekly
- [ ] Workout every Monday and Thursday
- [ ] Plan meals every Sunday`,
  },
  {
    id: 'content-calendar',
    title: 'Content calendar',
    emoji: '✍️',
    description: 'Ideas, drafts and publishing schedule.',
    category: 'work',
    markdown: `## Ideas
- Brainstorm topics here
## In progress
- [ ] Draft next article
- [ ] Review and edit
## Scheduled
- [ ] Publish weekly newsletter every Friday`,
  },
  {
    id: 'client-onboarding',
    title: 'Client onboarding',
    emoji: '💼',
    description: 'A repeatable checklist for welcoming new clients.',
    category: 'team',
    markdown: `## Before kickoff
- [ ] Send welcome email
- [ ] Share contract and invoice
- [ ] Create shared folder
## Kickoff call
- [ ] Confirm goals and timeline
- [ ] Introduce the team
## First two weeks
- [ ] Deliver first milestone
- [ ] Check-in call`,
  },
];
