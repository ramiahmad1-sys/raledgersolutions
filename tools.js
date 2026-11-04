/* RA Ledger Solutions: Free Tools
   Everything runs in the visitor's browser. Nothing is stored, collected or sent. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function $(id) { return document.getElementById(id); }

  var SITE_LINE = "raledgersolutions.com/tools";
  var DISCLAIMER = "For general information only. This is not accounting, tax or legal advice.";

  // Copy a plain-text summary to the visitor's own clipboard. Nothing is sent anywhere.
  function copyText(text, statusEl) {
    function done(ok) {
      statusEl.textContent = ok
        ? "Copied. Paste it into an email or a note for yourself."
        : "Your browser blocked copying. Try “Print my results” instead.";
      window.clearTimeout(statusEl._t);
      statusEl._t = window.setTimeout(function () { statusEl.textContent = ""; }, 7000);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.className = "copy-buffer";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  /* =========================================================
     TOOL 1: THE BOOKS CHECKUP
     ========================================================= */

  // Listed in order of importance; next steps follow this order.
  // "optional" questions also offer a "Doesn't apply" answer, which is left out of the score.
  var QUESTIONS = [
    {
      q: "Do your bank and credit card accounts get reconciled every month?",
      help: "Reconciling just means checking that your books match your bank statement, line by line.",
      friendly: "No judgment, most owners are somewhere in the middle.",
      good: "Your accounts are reconciled, so the numbers in your books match the bank.",
      step: "Reconcile each bank and credit card account to its monthly statement, starting with the most recent month. QuickBooks has a built-in Reconcile tool for this.",
      unsure: "Check when each account was last reconciled. The Reconcile screen in QuickBooks shows the last statement date for each one."
    },
    {
      q: "Is your “Uncategorized” or “Ask My Accountant” list close to empty?",
      help: "These are the transactions that haven't been sorted into a category yet.",
      friendly: "Everyone has a few. It's the pile-up that matters.",
      good: "Your transactions are categorized, so your reports tell a true story.",
      step: "Set aside an hour to sort your uncategorized transactions. Start with the largest amounts first.",
      unsure: "Open your Chart of Accounts in QuickBooks and look at the balance of any “Uncategorized” or “Ask My Accountant” account."
    },
    {
      q: "Are your books caught up to within the last 30 days?",
      help: "In other words, could you pull a fairly accurate Profit & Loss for last month today?",
      friendly: "Busy seasons happen. This is just a snapshot.",
      good: "Your books are current, which makes every decision easier.",
      step: "Pick one regular time each week, even 30 minutes, to keep the books moving. Small and steady beats big catch-ups.",
      unsure: "Look at the date of the most recent transaction you reviewed. That's how current your books really are."
    },
    {
      q: "Do you keep business and personal money in separate accounts?",
      help: "A dedicated business checking account and card, used only for the business.",
      friendly: "Lots of owners start out mixed. It's an easy fix.",
      good: "Business and personal money are kept apart, which makes tax time much simpler.",
      step: "Open a business-only checking account and card, and run all business money through them from here on.",
      unsure: "Scan last month's statements. If personal and business purchases share an account, that's your answer."
    },
    {
      q: "When you pay yourself, is it recorded as an owner draw, rather than a business expense?",
      help: "Money you take out for yourself usually isn't an expense of the business.",
      friendly: "This one trips up a lot of people. You're in good company.",
      good: "Your own pay is kept separate from expenses, so your profit numbers are easier to trust.",
      step: "Ask your bookkeeper or tax professional how payments to yourself should be recorded for your type of business, then set up the right account for them.",
      unsure: "Find a recent payment to yourself in QuickBooks and see which account it landed in."
    },
    {
      q: "Do you keep receipts for business purchases?",
      help: "Paper or digital both count. A photo on your phone is fine.",
      friendly: "A shoebox counts as a start!",
      good: "You keep your receipts, so you have records to back up your expenses.",
      step: "Snap a photo of each receipt as you get it. QuickBooks lets you attach receipt photos to transactions right from your phone.",
      unsure: "Pick five purchases from last month and see if you could find the receipt for each one."
    },
    {
      q: "Do you know who owes you money right now, and how much?",
      help: "Unpaid invoices from customers, sometimes called accounts receivable.",
      friendly: "Chasing payments is nobody's favorite job.",
      good: "You know who owes you money, so nothing slips through the cracks.",
      step: "Run an A/R Aging report and send a friendly reminder on anything more than 30 days old.",
      unsure: "Run the A/R Aging Summary report in QuickBooks. It lists unpaid invoices by customer."
    },
    {
      q: "If you collect sales tax, do you set it aside and file on time?",
      help: "Don't collect sales tax? Choose “Doesn't apply” and it won't count either way.",
      friendly: "Deadlines sneak up on everyone.",
      good: "You set sales tax aside and keep up with filing, which helps you avoid late surprises.",
      step: "Consider keeping the sales tax you collect in a separate savings account, and put your filing dates on your calendar. A tax professional can confirm what applies to you.",
      unsure: "Look up your filing schedule in your state sales tax account, or ask a tax professional to check it with you.",
      optional: true
    },
    {
      q: "Do you look at a Profit & Loss report at least once a quarter?",
      help: "A Profit & Loss (P&L) shows what came in, what went out and what's left.",
      friendly: "Last one! Thanks for sticking with it.",
      good: "You check your Profit & Loss regularly, so you know how the business is really doing.",
      step: "Put a quarterly reminder on your calendar to look over your Profit & Loss. Fifteen minutes is enough.",
      unsure: "Open your Profit & Loss for last quarter and see if anything surprises you."
    }
  ];

  var FALLBACK_GOOD = [
    "You took a few minutes to look honestly at your books. Many owners never get around to it.",
    "You were honest about where things stand, and that's how every cleanup starts.",
    "You're running a business and keeping it going. The books can catch up."
  ];
  var MAINTAIN_STEPS = [
    "Keep a simple monthly routine: reconcile, categorize, then glance at your Profit & Loss.",
    "Talk with a tax professional about setting money aside each month for taxes.",
    "Once a year, compare your pricing and biggest expenses with last year's numbers."
  ];
  var LEVELS = {
    good: {
      title: "In good shape",
      summary: "Nice work. Based on your answers, you're doing the things that keep a business easier to run. A little upkeep keeps it that way."
    },
    tidy: {
      title: "A few things to tidy",
      summary: "You've got a solid base to build on. A few areas need tidying, and each one is a small, doable fix."
    },
    cleanup: {
      title: "Worth a cleanup",
      summary: "You're not alone. Plenty of busy owners land here, and a cleanup is quicker than it sounds. You've already taken the first step."
    }
  };

  var ANSWER_LABELS = { yes: "Yes", unsure: "Not sure", no: "No", na: "Doesn't apply" };

  var CIRC = 2 * Math.PI * 27; // progress ring circumference (r = 27)
  var TOTAL = QUESTIONS.length;
  var answers = [];
  var current = 0;
  var busy = false;
  var lastCheckup = null;

  var ck = {
    intro: $("ck-intro"), quiz: $("ck-quiz"), result: $("ck-result"),
    ring: $("ck-ring"), ringText: $("ck-ring-text"), count: $("ck-count"),
    question: $("ck-question"), qText: $("ck-q-text"), qHelp: $("ck-q-help"), qFriendly: $("ck-q-friendly"),
    back: $("ck-back"), live: $("ck-live")
  };
  var answerButtons = Array.prototype.slice.call(document.querySelectorAll(".answer"));

  function resetAnswers() {
    answers = [];
    for (var i = 0; i < TOTAL; i++) answers.push(null);
    current = 0;
  }

  function showScreen(name) {
    ck.intro.hidden = name !== "intro";
    ck.quiz.hidden = name !== "quiz";
    ck.result.hidden = name !== "result";
  }

  function setRing(fraction) {
    ck.ring.style.strokeDashoffset = String(CIRC * (1 - fraction));
  }

  function renderQuestion(focus) {
    var item = QUESTIONS[current];
    var n = current + 1;
    ck.qText.textContent = item.q;
    ck.qHelp.textContent = item.help;
    ck.qFriendly.textContent = item.friendly;
    ck.count.textContent = "Question " + n + " of " + TOTAL;
    ck.ringText.textContent = n + "/" + TOTAL;
    setRing(current / TOTAL);
    answerButtons.forEach(function (b) {
      var value = b.getAttribute("data-answer");
      if (value === "na") b.hidden = !item.optional;
      b.setAttribute("aria-pressed", answers[current] === value ? "true" : "false");
    });
    ck.back.hidden = current === 0;
    if (focus) {
      ck.live.textContent = "Question " + n + " of " + TOTAL;
      ck.qText.focus();
    }
  }

  // Fade the question out, make the change, fade it back in.
  function transition(change) {
    if (reduceMotion) { change(); return; }
    busy = true;
    ck.question.classList.add("is-leaving");
    window.setTimeout(function () {
      change();
      ck.question.classList.remove("is-leaving");
      busy = false;
    }, 220);
  }

  function startCheckup() {
    resetAnswers();
    showScreen("quiz");
    renderQuestion(true);
  }

  function answer(value) {
    if (busy) return;
    answers[current] = value;
    answerButtons.forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-answer") === value ? "true" : "false");
    });
    setRing((current + 1) / TOTAL);
    if (current < TOTAL - 1) {
      transition(function () { current += 1; renderQuestion(true); });
    } else {
      transition(showResult);
    }
  }

  function goBack() {
    if (busy || current === 0) return;
    transition(function () { current -= 1; renderQuestion(true); });
  }

  function fillList(listEl, items) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    items.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      listEl.appendChild(li);
    });
  }

  function showResult() {
    // Yes = 2, Not sure = 1, No = 0. "Doesn't apply" is left out of the score entirely.
    var score = 0, max = 0;
    answers.forEach(function (a) {
      if (a === "na") return;
      max += 2;
      score += a === "yes" ? 2 : a === "unsure" ? 1 : 0;
    });
    var ratio = max ? score / max : 1;
    var level = LEVELS[ratio >= 0.8 ? "good" : ratio >= 0.5 ? "tidy" : "cleanup"];

    // What they're doing well: their "Yes" answers in order of importance, topped up with encouragement.
    var good = [];
    QUESTIONS.forEach(function (item, i) { if (answers[i] === "yes" && good.length < 3) good.push(item.good); });
    for (var g = 0; good.length < 3 && g < FALLBACK_GOOD.length; g++) good.push(FALLBACK_GOOD[g]);

    // Next steps: "No" answers first, then "Not sure", then everyday upkeep.
    var steps = [];
    QUESTIONS.forEach(function (item, i) { if (answers[i] === "no" && steps.length < 3) steps.push(item.step); });
    QUESTIONS.forEach(function (item, i) { if (answers[i] === "unsure" && steps.length < 3) steps.push(item.unsure); });
    for (var m = 0; steps.length < 3 && m < MAINTAIN_STEPS.length; m++) steps.push(MAINTAIN_STEPS[m]);

    var levelEl = $("ck-level");
    while (levelEl.firstChild) levelEl.removeChild(levelEl.firstChild);
    var badge = document.createElement("span");
    badge.className = "level-badge";
    badge.setAttribute("aria-hidden", "true");
    levelEl.appendChild(badge);
    levelEl.appendChild(document.createTextNode(level.title));
    $("ck-summary").textContent = level.summary;
    fillList($("ck-good"), good);
    fillList($("ck-steps"), steps);

    // Every question with the visitor's answer, for their own reference.
    var reviewList = $("ck-review-list");
    while (reviewList.firstChild) reviewList.removeChild(reviewList.firstChild);
    QUESTIONS.forEach(function (item, i) {
      var li = document.createElement("li");
      li.appendChild(document.createTextNode(item.q + " "));
      var a = document.createElement("span");
      a.className = "review-answer";
      a.textContent = ANSWER_LABELS[answers[i]] || "";
      li.appendChild(a);
      reviewList.appendChild(li);
    });
    $("ck-review").open = false;
    $("ck-copy-status").textContent = "";
    lastCheckup = { level: level, good: good, steps: steps, answers: answers.slice() };

    showScreen("result");
    ck.live.textContent = "Checkup complete. Your result: " + level.title + ".";
    levelEl.focus();
  }

  function restartCheckup() {
    resetAnswers();
    setRing(0);
    showScreen("intro");
    ck.live.textContent = "Checkup restarted.";
    $("ck-start").focus();
  }

  resetAnswers();
  $("ck-start").addEventListener("click", startCheckup);
  answerButtons.forEach(function (b) {
    b.addEventListener("click", function () { answer(b.getAttribute("data-answer")); });
  });
  ck.back.addEventListener("click", goBack);
  $("ck-restart").addEventListener("click", restartCheckup);
  $("ck-restart-mid").addEventListener("click", restartCheckup);

  $("ck-copy").addEventListener("click", function () {
    if (!lastCheckup) return;
    var lines = ["The Books Checkup – RA Ledger Solutions", "Result: " + lastCheckup.level.title, "", lastCheckup.level.summary, "", "What you're doing well:"];
    lastCheckup.good.forEach(function (t) { lines.push("- " + t); });
    lines.push("", "Your next 3 steps:");
    lastCheckup.steps.forEach(function (t, i) { lines.push((i + 1) + ". " + t); });
    lines.push("", "Your answers:");
    QUESTIONS.forEach(function (item, i) { lines.push((i + 1) + ". " + item.q + " " + (ANSWER_LABELS[lastCheckup.answers[i]] || "")); });
    lines.push("", DISCLAIMER, SITE_LINE);
    copyText(lines.join("\n"), $("ck-copy-status"));
  });

  /* =========================================================
     TOOL 2: THE RUNWAY CHECK
     ========================================================= */

  var rw = {
    cash: $("rw-cash"), inn: $("rw-in"), out: $("rw-out"),
    empty: $("rw-empty"), filled: $("rw-filled"),
    net: $("rw-net"), months: $("rw-months"), gauge: $("rw-gauge"), fill: $("rw-fill"),
    takeaway: $("rw-takeaway"), tip: $("rw-tip"), live: $("rw-live"),
    trim: $("rw-trim"), trimOut: $("rw-trim-out"), whatifText: $("rw-whatif-text"),
    ghost: $("rw-fill-whatif"), whatif: document.querySelector(".whatif")
  };
  var GAUGE_MAX = 12;
  var announceTimer = null;
  var lastRunway = null;
  var WHATIF_IDLE = "Slide to see how a small change could stretch your cash.";

  function parseMoney(str) {
    var cleaned = String(str || "").replace(/[^0-9.]/g, "");
    if (cleaned === "" || cleaned === ".") return null;
    var n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }
  function money(n) {
    var sign = n < 0 ? "−" : "";
    return sign + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
  }
  // "about 10 months", "about 2.5 months", "less than a month", "more than two years"
  function monthsPhrase(m) {
    if (m < 1) return "less than a month";
    if (m >= 24) return "more than two years";
    var r = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
    return "about " + r + (r === 1 ? " month" : " months");
  }
  function monthsShort(m) {
    if (m < 1) return "Under 1 month";
    if (m >= 24) return "24+ months";
    var r = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
    return r + (r === 1 ? " month" : " months");
  }

  // One short, calm announcement for screen readers after typing pauses.
  function announce(text) {
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(function () { rw.live.textContent = text; }, 900);
  }

  function updateRunway() {
    var cash = parseMoney(rw.cash.value), inn = parseMoney(rw.inn.value), out = parseMoney(rw.out.value);
    if (cash === null || inn === null || out === null) {
      rw.empty.hidden = false;
      rw.filled.hidden = true;
      lastRunway = null;
      window.clearTimeout(announceTimer);
      return;
    }
    rw.empty.hidden = true;
    rw.filled.hidden = false;

    var net = inn - out;
    rw.net.textContent = (net > 0 ? "+" : "") + money(net);

    var fraction, runwayText, takeaway, tip, gaugeLabel;
    if (net >= 0) {
      fraction = 1;
      runwayText = net > 0 ? "Growing" : "Steady";
      gaugeLabel = "Runway gauge: full. Your cash is not shrinking.";
      takeaway = net > 0
        ? "Good news: your business brings in more than it spends, about " + money(net) + " extra each month."
        : "Good news: money in and money out are balanced, so your cash is holding steady.";
      tip = net > 0
        ? "Consider moving a slice of each month's extra into a separate savings account for slow months."
        : "Build a little cushion by setting aside even 5% of what comes in each month.";
    } else {
      var months = cash / -net;
      fraction = Math.min(months / GAUGE_MAX, 1);
      runwayText = monthsShort(months);
      gaugeLabel = "Runway gauge: " + monthsPhrase(months) + " out of 12.";
      if (cash === 0) {
        takeaway = "More is going out than coming in, and there isn't a cash cushion yet. You're not stuck, and this is the moment a plan helps most.";
        tip = "Write down every bill due in the next 30 days and talk to vendors early. Many are willing to work with you.";
      } else if (months >= 12) {
        takeaway = "You have a comfortable cushion of " + monthsPhrase(months) + ", even if nothing changes.";
        tip = "Use this breathing room to review your three biggest expenses and see if any have crept up.";
      } else if (months >= 6) {
        takeaway = "You have a solid cushion of " + monthsPhrase(months) + ". That's time to make a plan, not a reason to worry.";
        tip = "Follow up on unpaid invoices first. It's often the fastest cash a business can find.";
      } else if (months >= 3) {
        takeaway = "Things are a little tight, with " + monthsPhrase(months) + " of cushion. Small changes now go a long way.";
        tip = "List your subscriptions and recurring bills. Many owners find one or two they no longer need.";
      } else {
        takeaway = "Cash is tight right now, with " + monthsPhrase(months) + " of cushion. You're not stuck, and this is the moment a plan helps most.";
        tip = "Write down every bill due in the next 30 days and talk to vendors early. Many are willing to work with you.";
      }
    }
    rw.months.textContent = runwayText;
    rw.fill.style.width = (fraction * 100).toFixed(1) + "%";
    rw.gauge.setAttribute("aria-label", gaugeLabel);
    rw.takeaway.textContent = takeaway;
    rw.tip.textContent = tip;
    lastRunway = { cash: cash, inn: inn, out: out, net: net, runwayText: runwayText, takeaway: takeaway, tip: tip, whatif: null };
    updateWhatIf();
    announce("Monthly net " + rw.net.textContent + ". Runway: " + runwayText + ". " + takeaway);
  }

  // What-if: how much further cash would go if monthly costs were trimmed. Illustration only.
  function updateWhatIf() {
    var pct = Number(rw.trim.value) || 0;
    rw.trimOut.textContent = pct + "%";
    var st = lastRunway;
    var text = WHATIF_IDLE, ghost = 0;
    if (st && pct > 0) {
      var saved = st.out * pct / 100;
      var newNet = st.inn - (st.out - saved);
      var lead = "Trimming costs by " + pct + "% (about " + money(saved) + " a month) ";
      if (st.net >= 0) {
        text = lead + "would leave you about " + money(newNet) + " ahead each month instead of " + money(st.net) + ".";
      } else if (newNet >= 0) {
        text = lead + "would stop your cash from shrinking.";
        ghost = 1;
      } else if (st.cash === 0) {
        text = lead + "would shrink the monthly gap from " + money(-st.net) + " to " + money(-newNet) + ".";
      } else {
        var m2 = st.cash / -newNet;
        text = lead + "would stretch your runway to " + monthsPhrase(m2) + ".";
        ghost = Math.min(m2 / GAUGE_MAX, 1);
      }
    }
    rw.whatifText.textContent = text;
    rw.ghost.style.width = (ghost * 100).toFixed(1) + "%";
    rw.whatif.classList.toggle("is-idle", pct === 0);
    if (st) st.whatif = pct > 0 ? text : null;
    return text;
  }

  // Tidy the number with commas when the visitor leaves a field.
  function formatField(e) {
    var n = parseMoney(e.target.value);
    if (n !== null) e.target.value = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  [rw.cash, rw.inn, rw.out].forEach(function (input) {
    input.addEventListener("input", updateRunway);
    input.addEventListener("blur", formatField);
  });
  $("rw-form").addEventListener("submit", function (e) { e.preventDefault(); });
  $("rw-reset").addEventListener("click", function () {
    rw.cash.value = ""; rw.inn.value = ""; rw.out.value = "";
    rw.trim.value = "0";
    rw.fill.style.width = "0";
    rw.ghost.style.width = "0";
    $("rw-copy-status").textContent = "";
    updateRunway();
    updateWhatIf();
    rw.live.textContent = "Runway Check cleared.";
    rw.cash.focus();
  });

  rw.trim.addEventListener("input", function () { announce(updateWhatIf()); });

  $("rw-copy").addEventListener("click", function () {
    var st = lastRunway;
    if (!st) return;
    var lines = [
      "The Runway Check – RA Ledger Solutions",
      "Cash on hand: " + money(st.cash),
      "Average money in each month: " + money(st.inn),
      "Average money out each month: " + money(st.out),
      "Monthly net: " + (st.net > 0 ? "+" : "") + money(st.net),
      "Runway: " + st.runwayText,
      "",
      st.takeaway,
      "A practical tip: " + st.tip
    ];
    if (st.whatif) lines.push("What-if: " + st.whatif);
    lines.push("", DISCLAIMER, "Results are simple estimates based only on the numbers entered. They are not a forecast or a guarantee.", SITE_LINE);
    copyText(lines.join("\n"), $("rw-copy-status"));
  });

  /* =========================================================
     PRINTING: print only the tool the visitor asked for
     ========================================================= */
  function stampPrintDate() {
    var when = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    $("print-meta").textContent = "RA Ledger Solutions, a DBA of Alquds Accounting Services LLC · 718-285-6959 · raledgersolutions.com/tools · " + when;
  }
  function printSection(cls) {
    document.body.classList.remove("print-checkup", "print-runway");
    document.body.classList.add(cls);
    stampPrintDate();
    window.print();
  }
  // Printouts always include the full list of answers, then put the page back as it was.
  var reviewWasOpen = false;
  window.addEventListener("beforeprint", function () {
    stampPrintDate();
    reviewWasOpen = $("ck-review").open;
    $("ck-review").open = true;
  });
  window.addEventListener("afterprint", function () {
    document.body.classList.remove("print-checkup", "print-runway");
    $("ck-review").open = reviewWasOpen;
  });
  $("ck-print").addEventListener("click", function () { printSection("print-checkup"); });
  $("rw-print").addEventListener("click", function () { printSection("print-runway"); });

  stampPrintDate();
  updateRunway();
})();
