import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      name: "dashboard",
      path: "/",
      component: () => import("@/views/DashboardView.vue"),
    },
    {
      name: "stream",
      path: "/s/:streamSlug",
      component: () => import("@/views/StreamView.vue"),
      props: true,
    },
    {
      path: "/p/:projectSlug",
      component: () => import("@/views/ProjectIndexView.vue"),
      props: true,
      children: [
        {
          name: "project",
          path: "",
          component: () => import("@/views/ProjectHomeView.vue"),
          props: true,
        },
        {
          name: "project-stream",
          path: "s/:streamSlug",
          component: () => import("@/views/ProjectStreamView.vue"),
          props: true,
        },
        {
          path: "d/:directorySlug",
          component: () => import("@/views/DirectoryIndexView.vue"),
          props: true,
          children: [
            {
              name: "directory",
              path: "",
              component: () => import("@/views/DirectoryHomeView.vue"),
              props: true,
            },
            {
              name: "directory-stream",
              path: "s/:streamSlug",
              component: () => import("@/views/DirectoryStreamView.vue"),
              props: true,
            },
          ],
        },
      ],
    },
  ],
});

export default router;
