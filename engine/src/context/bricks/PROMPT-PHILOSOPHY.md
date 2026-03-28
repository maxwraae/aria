
# THINGS THAT TRULY MATTER
* Words connotation, positive, neutral, negative or in between
* Specific words use and consistency
* Things that are "well known" vs new concepts. For an example if it has to LEARN a new language a new term, vs using something that is in the zeitgeist
* More text isn't the problem — conflicting text is
* 
* # How to Write Prompts

So the thing is, an LLM is the smartest new hire you've ever had on their first day. They can reason. They can follow logic. They can write, synthesize, analyze. But they know nothing about your company, your project, your conventions, your taste. Zero context.

And most people write prompts like they're talking to someone who already gets it. "Extract the important stuff." "Write a good summary." "Find the relevant information." That only works if you already know what *important*, *good*, and *relevant* mean in this specific context. The model doesn't. It's day one.

**So you have to build the world.**

## The Dark Room Test

Hand your prompt to a smart person who knows nothing about what you do. Put them in a dark room with the prompt and the data. Can they produce the right output?

If yes, your prompt is doing the work. If no, you're relying on assumptions you didn't write down.

Most prompts fail this test. The author knows too much. They write instructions that only make sense if you already understand the goal. They skip the explanation because it feels obvious to them. But it's not obvious. It's context that lives in your head and nowhere else.

The dark room test forces you to externalize everything. If the person in the dark room would ask "wait, what do you mean by that?", you haven't written enough.

## Understanding Beats Rules

This is the key thing.

Rules are brittle. They cover the cases you thought of. Understanding covers the cases you didn't.

When you tell a model "don't extract conversation events," it follows that rule until it hits an edge case the rule doesn't address. Is a decision an event? Is a plan? The model has to guess, and it guesses wrong half the time.

But when you teach the model *what world knowledge actually is*, when you explain how it differs from conversation, when you give it a way to think about the distinction, it handles every edge case. Because it gets it. The behavior emerges from comprehension, not compliance.

Like, think about how you'd train a new lab assistant. You could give them a 50-point checklist. They'd follow it rigidly and break the second they hit something the checklist doesn't cover. Or you could spend 30 minutes explaining how the experiment works, why each step matters, what you're actually trying to achieve. Then they improvise correctly when something unexpected happens. Because they understand the system, not just the steps.

**Don't list rules. Explain reality. The right behavior falls out.**

The Aria contract does this. It doesn't say "create children when you need to." It explains what objectives are, how the tree works, why breaking things down matters. And then creating children is obvious. The behavior emerges from understanding the world.

## The Six-Part Structure

1. **Task.** State it first. One sentence. What is the model's job? Before anything else. The model needs to know what game it's playing before it can learn the rules.

2. **Persona.** Not a costume. A thinking framework. "You are a cross-discipline researcher who thinks about how knowledge gets used" is useful. "You are a helpful assistant" is nothing.

3. **What You'll Receive.** Explain every input field. What it means. How to interpret it. Don't assume the model knows what your data looks like or what the fields represent.

4. **How To Think About This.** This is where the magic lives. The philosophical grounding. The mental model. The coffee shop test. Explain the world clearly enough that the right extraction falls out of understanding. This is where rules-based prompts fail and world-building prompts win.

5. **Examples.** From unrelated domains. This is the elegant move. You need to teach form without teaching content. The second you show a biology example in a biology extraction prompt, the model starts pattern-matching instead of thinking. It copies the structure of your example instead of reasoning about the actual input. Unrelated examples say "this is what the shape looks like" without saying "this is what the answer looks like."

6. **Output Format.** At the end. Keep it tight.

## Weather vs Climate

A useful distinction that keeps coming up. Some observations are weather: temporary, fast-decaying, true right now. "Max is frustrated about extraction quality." Some are climate: persistent, slow-changing, structurally true. "Max dislikes verbose output."

The difference isn't in the content. It's in the *timescale*. And the prompt has to make that distinction viscerally clear, not through a rule ("signals decay fast") but through understanding ("think about whether this observation will still be true in a month").

This generalizes. Whenever you're asking a model to classify or distinguish between categories, don't define the categories with rules. Explain the *dimension* that separates them. The model will classify correctly because it understands the axis, not because it memorized the buckets.

## The Deeper Pattern

This isn't just about prompts. It's a theory of communication.

Any time you're trying to get someone (human or model) to do something well, you have two options. You can constrain their behavior with rules, or you can expand their understanding of the world. Rules create compliance. Understanding creates competence.

The test is always: when they hit something you didn't anticipate, do they handle it well? If yes, you built understanding. If they freeze or do something wrong, you only built rules.

## What I'm still thinking about

Can a single well-built prompt extract multiple memory types in one pass if it truly understands what each type *is*? Or does each type need its own prompt with its own world-building? The world prompt works because it has one clear concept to teach. What happens when you need the model to hold ten distinctions simultaneously?

And there's a tension between the "prose explanation" approach and the "schema-driven" approach. Small models follow schemas better. Large models follow narratives better. The right choice depends on the model, which means the prompt philosophy has to flex based on who's reading it. That's an unsolved piece.

