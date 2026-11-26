/* 页面渲染：把 PROFILE 数据写入静态 DOM 容器。 */
import { $, esc } from "./dom.js";
import { PROFILE, ID, getInitial } from "./profile.js";

function renderProfile() {
  const initial = getInitial();
  document.title = ID.name + " · " + ID.role + " | 个人 AI 主页";

  $("#brandMark").textContent = initial;
  $("#brandName").textContent = ID.name;
  $("#brandRole").textContent = ID.role;
  $("#topbarBadge").textContent = ID.status;
  $("#topbarMail").href = "mailto:" + ID.email;

  $("#heroEyebrow").textContent = ID.role + " · " + ID.years + "经验 · " + ID.city;
  $("#heroName").textContent = ID.name;
  $("#heroHeadline").textContent = ID.headline;
  $("#heroIntro").textContent = ID.intro;
  $("#heroMeta").textContent = ID.meta;

  const tagHtml = ID.tags.map(function (tag, index) {
    return '<span class="tag' + (index === 0 ? " tag-accent" : "") + '">' + esc(tag) + "</span>";
  }).join("");
  const phoneIsNumber = /^[0-9+\-\s]{6,}$/.test(String(ID.phone || ""));
  const contactTags = phoneIsNumber
    ? '<a class="tag" href="tel:' + esc(ID.phone) + '">电话 ' + esc(ID.phone) + "</a>"
    : '<span class="tag">' + esc(ID.phone) + "</span>";
  $("#heroTags").innerHTML = tagHtml + contactTags;
  $("#heroMail").textContent = ID.email;
  $("#heroMail").href = "mailto:" + ID.email;

  $("#expNote").textContent = ID.years + " · " + PROFILE.experience.length + " 段";
  $("#projNote").textContent = PROFILE.projects.length + " 个项目";

  $("#experienceList").innerHTML = PROFILE.experience.map(function (item) {
    return '<article class="tl-item">' +
      '<p class="tl-period">' + esc(item.period) + "</p>" +
      '<h3 class="tl-role">' + esc(item.role) + ' <span class="tl-company">· ' + esc(item.company) + "</span></h3>" +
      '<p class="tl-desc">' + esc(item.desc) + "</p>" +
      '<ul class="tl-list">' + item.highlights.map(function (h) { return "<li>" + esc(h) + "</li>"; }).join("") + "</ul>" +
      (item.stack && item.stack.length
        ? '<div class="tag-row">' + item.stack.map(function (s) { return '<span class="pill">' + esc(s) + "</span>"; }).join("") + "</div>"
        : "") +
      "</article>";
  }).join("");

  $("#projectList").innerHTML = PROFILE.projects.map(function (project) {
    const metrics = project.metrics && project.metrics.length
      ? '<div class="project-metrics">' + project.metrics.map(function (m) {
          return '<div class="metric"><b>' + esc(m.value) + "</b><span>" + esc(m.label) + "</span></div>";
        }).join("") + "</div>"
      : "";
    const list = project.highlights && project.highlights.length
      ? '<ul class="project-list">' + project.highlights.map(function (h) { return "<li>" + esc(h) + "</li>"; }).join("") + "</ul>"
      : "";
    const stack = project.stack && project.stack.length
      ? '<div class="tag-row">' + project.stack.map(function (s) { return '<span class="pill">' + esc(s) + "</span>"; }).join("") + "</div>"
      : "";
    const ongoing = /至今|现在|present/i.test(String(project.period || ""));
    const status = '<span class="project-status' + (ongoing ? "" : " is-done") + '">' +
      (ongoing ? "持续维护" : "已交付") + "</span>";
    return '<article class="project">' +
      '<div class="project-top"><h3>' + esc(project.name) + '</h3>' + status + '<span class="project-period">' + esc(project.period) + "</span></div>" +
      '<p class="project-meta">' + esc(project.org) + " · " + esc(project.role) + "</p>" +
      '<p class="project-summary">' + esc(project.summary) + "</p>" +
      metrics + list + stack +
      "</article>";
  }).join("");

  $("#skillGrid").innerHTML = PROFILE.skills.map(function (group) {
    return '<div class="skill-card"><h3>' + esc(group.group) + "</h3>" +
      '<div class="tag-row">' + group.items.map(function (item) { return '<span class="pill">' + esc(item) + "</span>"; }).join("") + "</div>" +
      "</div>";
  }).join("");

  $("#eduList").innerHTML = PROFILE.education.map(function (edu) {
    return '<div class="edu-card">' +
      '<div class="edu-main"><h3>' + esc(edu.school) + "</h3>" +
      "<p>" + esc(edu.degree) + " · " + esc(edu.major) + "</p>" +
      (edu.notes && edu.notes.length
        ? '<ul class="edu-notes">' + edu.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>"
        : "") +
      "</div>" +
      '<span class="edu-period">' + esc(edu.period) + "</span>" +
      "</div>";
  }).join("");

  $("#contactText").textContent = ID.contactNote;
  $("#contactMail").href = "mailto:" + ID.email;
  $("#contactPhone").hidden = !phoneIsNumber;
  if (phoneIsNumber) $("#contactPhone").href = "tel:" + ID.phone;
  $("#contactFoot").textContent = (phoneIsNumber ? "电话 " + ID.phone + " · " : "") +
    "邮箱 " + ID.email + " · 现居 " + ID.city;
  $("#pageFoot").textContent = "© " + new Date().getFullYear() + " " + ID.name + " · 个人 AI 主页 · 资料来自本人简历";

  $("#chatAvatar").textContent = initial;
  $("#chatName").textContent = ID.name + " 的 AI 版";
  $("#chatChips").innerHTML = PROFILE.chips.map(function (question) {
    return '<button class="chip" type="button" data-q="' + esc(question) + '">' + esc(question) + "</button>";
  }).join("");
}

export { renderProfile };
