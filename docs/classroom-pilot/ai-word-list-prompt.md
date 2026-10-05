# Getting a week's words into the app (with any AI assistant)

Use this when you have the school's list as a photo, PDF or text. Paste the prompt below into Claude, ChatGPT or
similar, attach the list, fill in the four details, and copy **only the code block** it gives back into
**Teacher Dashboard → 📝 Word Lists**. Then tap **Preview → Check the words** and compare against the paper list
before **Save**.

How weeks are dated: the app dates week N as *(term start date) + 7 × (N − 1) days*. Keep the same term start date all
year. To leave a gap for a holiday, just skip a number (WEEK 5 then WEEK 7).

The app now tolerates bullets, numbering, headings, code fences and one blank line inside a week, but the prompt still
asks for clean output, because a clean paste is easiest to check.

```text
Convert the attached spelling/vocabulary list into plain text for a spelling app.
Follow the format exactly.

MY DETAILS (filled in by me):
- Grade: 3
- Term start date (the Monday of Week 1; it never changes all year): 2026-09-07
- Week number(s) in this list: 6
- Bible verse reference for each week (or "none"): Proverbs 3:5-6

OUTPUT: one code block containing ONLY these lines, nothing else:

GRADE <grade> (starts <term start date>)

WEEK <week number>
VERSE <reference>          <- leave this line out if there is no verse
<spelling word>
<spelling word>
<vocabulary word>, <definition>
<vocabulary word>, <definition>

RULES
1. One entry per line. Spelling words first, then vocabulary words, no blank line between them.
2. No numbers, bullets, headings ("Spelling Words:"), bold, or any extra text inside the block.
3. Copy every word EXACTLY as printed (spelling, capitals, hyphens). Never correct, simplify, add or drop a word.
   Multi-word entries such as "1 and 2 Samuel" stay on one line.
4. Vocabulary: the word, a comma and one space, then the definition as printed (commas inside the definition are
   fine). If no definition is printed, write the word alone. Do NOT invent definitions.
5. For the verse, write only the reference (for example "Prov 3:5-6"). The app fills in the King James text itself.
6. If I give several weeks, write ONE GRADE line at the top, then each week as its own WEEK block, with one blank line
   between WEEK blocks.

AFTER the code block (outside it), list anything you were unsure about as "CHECK: <word> - <reason>" and say how many
spelling and vocabulary words you found per week. I will copy ONLY the code block into the app.
```

## Checking before you save
- **Preview → Check the words:** the count per week matches the paper list; every word and definition is right.
- The verse line shows the reference you expected (it resolves to KJV text when you Save).
- If the AI flagged a `CHECK:` item, fix that word first.
- Never save a list you haven't compared to the paper original.
