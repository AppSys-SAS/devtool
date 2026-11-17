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
      name: "environment",
      path: "/environment",
      component: () => import("@/views/EnvironmentView.vue"),
    },
    {
      name: "configs",
      path: "/configs",
      component: () => import("@/views/FileSpaceView.vue"),
      props: { space: "configs", name: "Configs" },
    },
    {
      name: "integration",
      path: "/i/:integration",
      component: () => import("@/views/IntegrationView.vue"),
      props: true,
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
            {
              name: "directory-files",
              path: "files/:fileSpace",
              component: () => import("@/views/DirectoryFilesView.vue"),
              props: true,
            },
            {
              name: "directory-integration",
              path: "i/:integration",
              component: () => import("@/views/IntegrationView.vue"),
              props: true,
            },
          ],
        },
      ],
    },
  ],
});

export default router;
