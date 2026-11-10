const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResumeContext, parseResume } = require('../src/resume-context');
const { buildInterviewContext, buildInterviewContextParts, detectCategory } = require('../src/interview-context');

// ── buildResumeContext (backward-compat shim) ─────────────────────────────────
test('buildResumeContext returns a structured prompt block for resume text', () => {
  const resume = 'Jane Doe\nSoftware Engineer\n\nSkills\nJavaScript, Node.js\n\nExperience\n3 years at Acme Corp';
  const result = buildResumeContext(resume, '', 'say');
  assert.ok(result !== null, 'should not be null');
  assert.match(result, /Your Background/i);
  assert.match(result, /Jane Doe/);
  assert.match(result, /JavaScript/);
});

test('buildResumeContext returns null for empty input', () => {
  assert.equal(buildResumeContext('', '', 'say'), null);
  assert.equal(buildResumeContext(null, '', 'say'), null);
});

test('buildResumeContext still works with legacy (text, limit) signature', () => {
  const resume = 'Jane Doe\nSoftware Engineer\nSkills: JavaScript, Node.js';
  const result = buildResumeContext(resume, 200);
  assert.ok(result !== null);
  assert.match(result, /Jane Doe/);
});

// ── parseResume ───────────────────────────────────────────────────────────────
test('parseResume detects structured sections', () => {
  const resume = 'Jane Doe\n\nSummary\nExperienced engineer.\n\nSkills\nJavaScript, Node.js\n\nExperience\nAcme Corp 2020-2023';
  const parsed = parseResume(resume);
  assert.ok(parsed.parsed, 'should detect structured resume');
  assert.ok(parsed.sections.name, 'should extract name');
  assert.ok(parsed.sections.skills, 'should extract skills');
});

// ── detectCategory ────────────────────────────────────────────────────────────
test('detectCategory: behavioral questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'Tell me about a time you failed.' }]), 'behavioral');
  assert.equal(detectCategory([{ channel: 'them', text: 'Give me an example of when you led a team.' }]), 'behavioral');
});

test('detectCategory: motivation questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'Why do you want to work here?' }]), 'motivation');
  assert.equal(detectCategory([{ channel: 'them', text: 'Why should we hire you?' }]), 'motivation');
  assert.equal(detectCategory([{ channel: 'them', text: 'Why are you looking for a new opportunity?' }]), 'motivation');
});

test('detectCategory: experience questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'Walk me through your role at PayCo.' }]), 'experience');
  assert.equal(detectCategory([{ channel: 'them', text: 'Tell me about yourself.' }]), 'experience');
  assert.equal(detectCategory([{ channel: 'them', text: 'Tell me about your current role.' }]), 'experience');
});

test('detectCategory: compensation questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'What are your salary expectations?' }]), 'compensation');
  assert.equal(detectCategory([{ channel: 'them', text: 'Do you have any questions for me?' }]), 'compensation');
});

test('detectCategory: technical questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'How would you design a distributed cache?' }]), 'technical');
  assert.equal(detectCategory([{ channel: 'them', text: 'What is the difference between SQL and NoSQL?' }]), 'technical');
});

test('detectCategory: returns general for empty transcript', () => {
  assert.equal(detectCategory([]), 'general');
  assert.equal(detectCategory(null), 'general');
});

test('detectCategory: only checks "them" channel, not "you" channel', () => {
  // "You" channel saying a behavioral phrase should NOT trigger behavioral detection
  const result = detectCategory([{ channel: 'you', text: 'Tell me about a time you failed.' }]);
  assert.equal(result, 'general');
});

// ── buildInterviewContext ─────────────────────────────────────────────────────
const fullSettings = {
  resumeText: 'Jane Doe\nEngineer\n\nSkills\nPython, Go\n\nExperience\nPayCo 2021-2024, built payment pipeline',
  jobDescription: 'Senior Backend Engineer, Python, distributed systems',
  starStories: 'At PayCo, Black Friday outage. I fixed Redis exhaustion in 12 min. Incidents dropped 80%.',
  whyCompany: 'Love the engineering culture here.',
  whyLeaving: 'Ready for a bigger challenge.',
  workStyle: 'Autonomous, data-driven, direct feedback.',
  salaryTarget: '$170k-$200k',
  questionsToAsk: '1. What does success look like in 90 days?'
};

test('buildInterviewContext: behavioral injects STAR stories', () => {
  const ctx = buildInterviewContext(fullSettings, 'say',
    [{ channel: 'them', text: 'Tell me about a time you faced a major outage.' }]);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('STAR'), 'should include STAR stories');
  assert.ok(ctx.includes('PayCo'), 'should include resume');
});

test('buildInterviewContext: motivation injects why company / why leaving', () => {
  const ctx = buildInterviewContext(fullSettings, 'say',
    [{ channel: 'them', text: 'Why do you want to work here?' }]);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Why This Company'), 'should include why company');
  assert.ok(ctx.includes('Why Leaving'), 'should include why leaving');
});

test('buildInterviewContext: compensation injects salary and questions', () => {
  const ctx = buildInterviewContext(fullSettings, 'say',
    [{ channel: 'them', text: 'What are your salary expectations?' }]);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('170k'), 'should include salary target');
  assert.ok(ctx.includes('success look like'), 'should include questions to ask');
});

test('buildInterviewContext: leetcode returns null', () => {
  assert.equal(buildInterviewContext(fullSettings, 'leetcode', []), null);
});

test('buildInterviewContext: returns null with no settings data', () => {
  const empty = { resumeText: '', jobDescription: '', starStories: '', whyCompany: '', whyLeaving: '', workStyle: '', salaryTarget: '', questionsToAsk: '' };
  assert.equal(buildInterviewContext(empty, 'say', [{ channel: 'them', text: 'Tell me about yourself.' }]), null);
});

test('buildInterviewContext: JD tailor note included when JD is set', () => {
  const ctx = buildInterviewContext(fullSettings, 'say', []);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('tailor it to the target role'), 'should include tailor note when JD is set');
  assert.ok(!/Tailor every answer/.test(ctx), 'tailoring applies to answers about the candidate, not to every answer');
});

test('buildInterviewContext: background is scoped to questions about the candidate', () => {
  const ctx = buildInterviewContext(fullSettings, 'ask', [], 'How does Kerberos delegation work?');
  assert.match(ctx, /WHEN TO USE THE BACKGROUND/);
  assert.match(ctx, /knowledge question about a tool, technology, or domain that is not on the resume still gets a full, direct answer/);
});

test('buildInterviewContext: unclassified questions mark personal notes as conditional', () => {
  const ctx = buildInterviewContext(fullSettings, 'ask', [], 'Design a rate limiter for a public API.');
  assert.match(ctx, /Key Experience Highlights/);
  assert.match(ctx, /Use them only if the question is about the candidate/);
});

test('buildInterviewContext: the fixed part does not depend on the question', () => {
  const a = buildInterviewContextParts(fullSettings, 'ask', [], 'How does Kerberos delegation work?');
  const b = buildInterviewContextParts(fullSettings, 'ask', [], 'Tell me about a time you led a project.');
  assert.equal(a.fixed, b.fixed);
});

// ── Multi-role & 1st-person hardening regression tests ─────────────────────────
const sampleComplexResume = `Peter Nguyen
(262) 844-1613 | peternguyen1816@gmail.com | linkedin.com/in/nguyenhuypeter
EXPERIENCE
Ecolab St. Paul, MN
Application Security Engineer, Product Security January 2026 – Present
• Piloted AI-powered security testing tools (Wiz Red Agent, Microsoft MDASH) across enterprise applications.
Software Engineer, Healthcare & Life Sciences July 2024 – December 2025
• Cut page load times by 99% (26+ seconds to 120ms) on a healthcare portal serving 30,000+ users.
University of Minnesota Barker Lab Minneapolis, MN
Machine Learning Research Assistant September 2023 – May 2024
• Developed a 3D U-Net brain segmentation pipeline that cut annotation time from 2+ hours to 4 minutes per specimen.
ADDITIONAL EXPERIENCE
Teaching Assistant – Linear Algebra, Computational Microbiology | University of Minnesota 2022 – 2023
• Built GitHub Classroom/pytest autograding for 30+ students and led 6 hrs/week of Python and R bioinformatics labs.
TECHNICAL EXPERTISE
Languages: C#, TypeScript/JavaScript, Python, SQL
Engineering: .NET (EF Core), React, Node.js, REST APIs, Azure, Docker
EDUCATION
University of Minnesota – Twin Cities Minneapolis, MN
Bachelor of Computer Science May 2024`;

test('parseResume: handles multi-role resumes with ADDITIONAL EXPERIENCE and TECHNICAL EXPERTISE', () => {
  const parsed = parseResume(sampleComplexResume);
  assert.ok(parsed.parsed, 'should detect sections');
  assert.equal(parsed.sections.name, 'Peter Nguyen');
  assert.ok(parsed.sections.experience.includes('Barker Lab'), 'experience must include Barker Lab');
  assert.ok(parsed.sections.experience.includes('Ecolab'), 'experience must include Ecolab');
  assert.ok(parsed.sections.experience.includes('Teaching Assistant'), 'experience must aggregate ADDITIONAL EXPERIENCE');
  assert.ok(parsed.sections.skills.includes('TypeScript'), 'skills must match TECHNICAL EXPERTISE');
  assert.ok(parsed.sections.education.includes('Bachelor of Computer Science'), 'education must be parsed');
});

test('buildInterviewContext: retains Barker Lab and detects 1st-person typed questions', () => {
  const settings = { ...fullSettings, resumeText: sampleComplexResume };
  // User typed prompt into Composer: "tell me about my machine learning research assistant experience"
  const ctx = buildInterviewContext(settings, 'ask', [], 'tell me about my machine learning research assistant experience');
  assert.ok(ctx !== null, 'context should be non-null');
  assert.ok(ctx.includes('Barker Lab'), 'prompt context must contain Barker Lab research experience');
  assert.ok(ctx.includes('Machine Learning Research Assistant'), 'prompt context must contain ML role');
  assert.ok(ctx.includes('Ecolab'), 'prompt context must contain Ecolab');
});

test('detectCategory: handles 1st-person typed questions and role-specific inquiries', () => {
  assert.equal(detectCategory([], 'tell me about my machine learning research assistant experience'), 'experience');
  assert.equal(detectCategory([], 'walk me through my background at ecolab'), 'experience');
  assert.equal(detectCategory([], 'what should i say about my time at barker lab?'), 'experience');
  assert.equal(detectCategory([], 'give me an example of when i handled an outage'), 'behavioral');
  assert.equal(detectCategory([], 'why did i leave my previous company?'), 'motivation');
});

test('parseResume: handles markdown headers and inline headers', () => {
  const md = '# Jane Doe\n## Experience\nEngineer at FastCo\n## Skills\nGo, Rust';
  const parsedMd = parseResume(md);
  assert.equal(parsedMd.sections.name, 'Jane Doe');
  assert.ok(parsedMd.sections.experience.includes('FastCo'));
  assert.ok(parsedMd.sections.skills.includes('Go'));

  const inline = 'John Doe\nSummary: Security analyst.\nSkills: Wiz, Snyk\nExperience:\nAnalyst at GuardCo';
  const parsedInline = parseResume(inline);
  assert.ok(parsedInline.sections.skills.includes('Wiz'));
  assert.ok(parsedInline.sections.experience.includes('GuardCo'));
});

test('buildInterviewContext: includes Source Citation and No-Bluff / Bridge rules when resume or stories exist', () => {
  const ctx = buildInterviewContext(fullSettings, 'say', [
    { channel: 'them', text: 'Tell me about your experience with Kubernetes.' }
  ]);
  assert.ok(ctx !== null);
  assert.match(ctx, /\[Source:/);
  assert.match(ctx, /\[Not on resume — bridge\]/);
});

